import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* =========================================================================
   遊戯王 デッキメーカー - Phase 1
   ---------------------------------------------------------------------
   データソース:
   - YGOProDeck API (https://db.ygoprodeck.com/api/v7/cardinfo.php)
     -> 常に最新のカードプール / カード画像 / セット情報
   - yaml-yugi 集約データ (https://dawnbrandbots.github.io/yaml-yugi/cards.json)
     -> 日本語カード名・日本語テキスト・OCGリミットレギュレーションの付与
        (YGOProDeck APIは ja を公式サポートしていないため、名前検索と
        表示だけこちらのデータで補っています)
   ========================================================================= */

const YGOPRODECK_BASE = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const YAMLYUGI_CARD_BASE = "https://cdn.jsdelivr.net/gh/DawnbrandBots/yaml-yugi/data/cards/";
const LIMIT_REGULATION_URL = "https://appmedia.jp/master_duel/27463944";
const DECK_PROXY_URL = "https://ygo-deck-maker.ai-connect-main.workers.dev/";

const MAIN_MAX = 60;
const MAIN_RECOMMENDED_MIN = 40;
const EXTRA_MAX = 15;
const SIDE_MAX = 15;

const ZONES = [
  { key: "main", label: "メイン", max: MAIN_MAX },
  { key: "extra", label: "エクストラ", max: EXTRA_MAX },
  { key: "side", label: "サイド", max: SIDE_MAX },
];

/* -------------------------------------------------------------------------
   日本語名インデックス(埋め込みデータ)
   ---------------------------------------------------------------------
   yaml-yugi の集約データ(cards.json, 約90MB)はブラウザから直接fetchすると
   不安定なため、id・日本語名・ローマ字・英語名・OCG制限だけに絞った軽量版を
   ビルド時に同梱しています。効果テキストの日本語訳は必要になった時だけ
   jsDelivr経由でカード単位で取得します(YAMLYUGI_CARD_BASE参照)。
   各行の形式: [パスコード, 日本語名, 英語名, ローマ字, 制限コード(f/l/s/空)]
   ------------------------------------------------------------------------- */
const LIMIT_FROM_CODE = { f: "Forbidden", l: "Limited", s: "Semi-Limited" };

// 日本語名インデックスは public/ja-name-index.json から起動時にfetchする
// (同一オリジンなのでCORS/サンドボックスの影響を受けない)
function buildNameIndex(rows) {
  return new Map(
    rows.map(([id, ja, readingKata, en, romaji, code]) => [
      id,
      { ja, readingKata, en, romaji, limitOcg: LIMIT_FROM_CODE[code] || "Unlimited" },
    ])
  );
}

/* ------------------------------- helpers -------------------------------- */

// yaml-yugi の日本語名/テキストには <ruby><rt>ふりがな</rt></ruby> が
// 埋め込まれているので、表示用に本体の漢字だけ取り出す
function cleanRuby(raw) {
  if (!raw) return null;
  return raw.replace(/<rt>.*?<\/rt>/g, "").replace(/<\/?ruby>/g, "").trim();
}

// ひらがなをカタカナに正規化(埋め込み済みの読みデータはカタカナ統一なので、
// 検索クエリ側もカタカナに揃えてから比較する)
function toKatakana(str) {
  return str.replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

function isExtraDeckType(typeStr) {
  return /fusion|synchro|xyz|link/i.test(typeStr || "");
}

function limitToMax(limit) {
  switch (limit) {
    case "Forbidden":
      return 0;
    case "Limited":
      return 1;
    case "Semi-Limited":
      return 2;
    default:
      return 3;
  }
}

function limitLabel(limit) {
  switch (limit) {
    case "Forbidden":
      return { text: "禁止", cls: "bg-red-600" };
    case "Limited":
      return { text: "制限", cls: "bg-yellow-500" };
    case "Semi-Limited":
      return { text: "準制限", cls: "bg-blue-500" };
    default:
      return null;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function zoneOf(card) {
  if (!card) return "main";
  return isExtraDeckType(card.type) ? "extra" : "main";
}

// .ydk テキストを {main:[id...], extra:[id...], side:[id...]} に分解
function parseYdk(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out = { main: [], extra: [], side: [] };
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (line === "#main") { current = "main"; continue; }
    if (line === "#extra") { current = "extra"; continue; }
    if (line === "!side") { current = "side"; continue; }
    if (line.startsWith("#")) continue;
    if (current && /^\d+$/.test(line)) out[current].push(parseInt(line, 10));
  }
  return out;
}

// 同じIDの重複を {id, qty} にまとめる
function groupIds(ids) {
  const map = new Map();
  for (const id of ids) map.set(id, (map.get(id) || 0) + 1);
  return Array.from(map.entries()).map(([id, qty]) => ({ id, qty }));
}

function ydkSectionsToDeck(sections) {
  return {
    main: groupIds(sections.main),
    extra: groupIds(sections.extra),
    side: groupIds(sections.side),
  };
}

function deckCardCount(d) {
  const sum = (arr) => arr.reduce((s, c) => s + c.qty, 0);
  return sum(d.main) + sum(d.extra) + sum(d.side);
}

/* ------------------------------- storage -------------------------------- */
/* 実際のWebサイトとして動くので、標準の localStorage を使う */

const STORAGE_KEY = "ygo-deckmaker:mydeck";

async function loadDeckFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveDeckToStorage(deck) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(deck));
    return true;
  } catch {
    return false;
  }
}

/* --- インポートしたデッキのライブラリ(一括ダウンロードしたYDKの保管庫) --- */

const LIBRARY_KEY = "ygo-deckmaker:library";

async function loadLibraryFromStorage() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveLibraryToStorage(library) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------- App ----------------------------------- */

export default function App() {
  const [activeZone, setActiveZone] = useState("main");
  const [deck, setDeck] = useState({ main: [], extra: [], side: [] });

  const [cardCache, setCardCache] = useState({}); // id -> full YGOProDeck card
  const [jaTextCache, setJaTextCache] = useState({}); // id -> 日本語効果テキスト(遅延取得)
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]); // array of ids
  const [searching, setSearching] = useState(false);

  const [selectedCardId, setSelectedCardId] = useState(null);
  const [toast, setToast] = useState(null);
  const [exportText, setExportText] = useState(null);

  const [library, setLibrary] = useState([]); // インポート済みデッキの一覧(閲覧専用)
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [customFormat, setCustomFormat] = useState("");
  const [fetchError, setFetchError] = useState(null); // YGOProDeck通信の実エラーを画面表示するため

  const [nameIndex, setNameIndex] = useState(null); // 起動時に public/ja-name-index.json から読み込む

  const debounceRef = useRef(null);
  const fetchingIdsRef = useRef(new Set());
  const fileInputRef = useRef(null);

  /* ---- 起動時: 日本語名インデックス + 保存済みデッキ・ライブラリの復元 ---- */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}ja-name-index.json`);
        const rows = await res.json();
        setNameIndex(buildNameIndex(rows));
      } catch (e) {
        console.error("[名前インデックス] 読み込み失敗:", e);
        setFetchError("日本語名インデックスの読み込みに失敗しました。英語名での検索のみ利用できます。");
      }
    })();

    (async () => {
      const saved = await loadDeckFromStorage();
      if (saved) {
        setDeck(saved);
        const ids = [
          ...saved.main.map((c) => c.id),
          ...saved.extra.map((c) => c.id),
          ...saved.side.map((c) => c.id),
        ];
        if (ids.length) fetchCardsByIds(ids);
      }
    })();

    (async () => {
      const lib = await loadLibraryFromStorage();
      setLibrary(lib);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(msg, kind = "info") {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  }

  /* ---- カード個別の日本語効果テキストを必要な時だけ取得(軽量、jsDelivr経由) ---- */
  const fetchJaText = useCallback(async (id) => {
    if (jaTextCache[id] !== undefined) return;
    try {
      const path = String(id).padStart(8, "0");
      const res = await fetch(`${YAMLYUGI_CARD_BASE}${path}.json`);
      if (!res.ok) throw new Error("not found");
      const data = await res.json();
      const text = cleanRuby(data?.text?.ja) || null;
      setJaTextCache((prev) => ({ ...prev, [id]: text }));
    } catch {
      setJaTextCache((prev) => ({ ...prev, [id]: null }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jaTextCache]);

  /* ---- YGOProDeck からカード実データを取得してキャッシュ ---- */
  const fetchCardsByIds = useCallback(async (ids) => {
    const need = [...new Set(ids)].filter(
      (id) => !cardCache[id] && !fetchingIdsRef.current.has(id)
    );
    if (need.length === 0) return;
    need.forEach((id) => fetchingIdsRef.current.add(id));

    for (const group of chunk(need, 20)) {
      try {
        const url = `${YGOPRODECK_BASE}?id=${group.join(",")}`;
        const res = await fetch(url);
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.error) detail = errJson.error;
          } catch {
            /* 本文がJSONでない場合はステータスコードのみ表示 */
          }
          console.error("[YGOProDeck] cardinfo取得失敗:", detail, url);
          setFetchError(`カード情報の取得に失敗しました(${detail})`);
          continue;
        }
        const json = await res.json();
        const found = json.data || [];
        setCardCache((prev) => {
          const next = { ...prev };
          for (const c of found) next[c.id] = c;
          return next;
        });
        setFetchError(null);
      } catch (e) {
        // fetch自体が例外を投げるのは主にネットワーク到達不可 / CORSブロックのケース
        console.error("[YGOProDeck] fetch例外:", e);
        setFetchError(
          `カード画像・情報を取得できません(${e.message || "ネットワークエラー"})。CORSまたは通信環境の問題の可能性があります。`
        );
      } finally {
        group.forEach((id) => fetchingIdsRef.current.delete(id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardCache]);

/* ---- 検索 (ローカル日本語インデックス -> YGOProDeckでID解決) ---- */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query || query.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      const raw = query.trim();
      const rawNoDot = raw.replace(/[・･]/g, "");
      const q = raw.toLowerCase();
      const qKata = toKatakana(raw).replace(/[・･]/g, "");
      let ids = [];

      if (nameIndex) {
        for (const [id, info] of nameIndex.entries()) {
          const jaNoDot = info.ja ? info.ja.replace(/[・･]/g, "") : "";
          const readingNoDot = info.readingKata ? info.readingKata.replace(/[・･]/g, "") : "";
          const hit =
            (info.ja && (info.ja.includes(raw) || jaNoDot.includes(rawNoDot))) ||
            (info.readingKata && qKata.length >= 2 && readingNoDot.includes(qKata)) ||
            (info.romaji && info.romaji.toLowerCase().includes(q)) ||
            (info.en && info.en.toLowerCase().includes(q));
          if (hit) ids.push(id);
          if (ids.length >= 40) break;
        }
      }

      if (ids.length === 0) {
        try {
          const res = await fetch(`${YGOPRODECK_BASE}?fname=${encodeURIComponent(query.trim())}&num=40&offset=0`);
          if (res.ok) {
            const json = await res.json();
            ids = (json.data || []).map((c) => c.id);
          }
        } catch {
          /* noop */
        }
      }

      setSearchResults(ids);
      if (ids.length) fetchCardsByIds(ids);
      setSearching(false);
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, nameIndex]);

  /* ---- デッキ操作 ---- */
  function getQty(zone, id) {
    return deck[zone].find((c) => c.id === id)?.qty || 0;
  }

  function totalCopies(id) {
    return getQty("main", id) + getQty("extra", id) + getQty("side", id);
  }

  function maxAllowed(id) {
    const info = nameIndex?.get(id);
    return info ? limitToMax(info.limitOcg) : 3;
  }

  function setQty(zone, id, newQty) {
    setDeck((prev) => {
      const zoneMax = ZONES.find((z) => z.key === zone).max;
      const currentZoneTotal = prev[zone].reduce((s, c) => s + c.qty, 0);
      const currentThis = prev[zone].find((c) => c.id === id)?.qty || 0;
      const delta = newQty - currentThis;

      if (delta > 0 && currentZoneTotal + delta > zoneMax) {
        showToast(`${ZONES.find((z) => z.key === zone).label}デッキは${zoneMax}枚までです`, "error");
        return prev;
      }
      const otherZonesTotal =
        (zone !== "main" ? getQtyFromDeck(prev, "main", id) : 0) +
        (zone !== "extra" ? getQtyFromDeck(prev, "extra", id) : 0) +
        (zone !== "side" ? getQtyFromDeck(prev, "side", id) : 0);
      const cap = maxAllowed(id);
      if (delta > 0 && otherZonesTotal + newQty > cap) {
        showToast(`このカードはデッキ全体で最大${cap}枚までです`, "error");
        return prev;
      }

      const list = prev[zone].filter((c) => c.id !== id);
      if (newQty > 0) list.push({ id, qty: newQty });
      return { ...prev, [zone]: list };
    });
  }

  function getQtyFromDeck(d, zone, id) {
    return d[zone].find((c) => c.id === id)?.qty || 0;
  }

  function addOneFromSearch(id) {
    const card = cardCache[id];
    if (!card) {
      showToast("カード情報を取得中です。もう一度お試しください", "error");
      return;
    }
    const zone = zoneOf(card);
    const current = getQty(zone, id);
    setQty(zone, id, current + 1);
  }

  async function handleSave() {
    const ok = await saveDeckToStorage(deck);
    showToast(ok ? "デッキを保存しました" : "保存に失敗しました", ok ? "info" : "error");
  }

  function handleClearAll() {
    if (!window.confirm("デッキを全て削除します。よろしいですか?")) return;
    setDeck({ main: [], extra: [], side: [] });
    showToast("デッキを全削除しました");
  }

  /* ---- YDKファイルの一括インポート(ブックマークレット等で集めたファイルの取り込み) ---- */
  async function handleImportFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setImporting(true);
    const newEntries = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const sections = parseYdk(text);
        const asDeck = ydkSectionsToDeck(sections);
        if (deckCardCount(asDeck) === 0) continue;
        newEntries.push({
          key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name.replace(/\.ydk$/i, ""),
          ...asDeck,
        });
      } catch {
        /* 読めないファイルはスキップ */
      }
    }
    if (newEntries.length === 0) {
      showToast("読み込めるデッキがありませんでした", "error");
      setImporting(false);
      e.target.value = "";
      return;
    }
    setLibrary((prev) => {
      const next = [...prev, ...newEntries];
      saveLibraryToStorage(next);
      return next;
    });
    showToast(`${newEntries.length}件のデッキを読み込みました`);
    setImporting(false);
    e.target.value = "";
  }

   async function importFromDeckUrl(deckUrl) {
    if (!deckUrl.trim()) return;
    setImporting(true);
    try {
      const res = await fetch(`${DECK_PROXY_URL}?url=${encodeURIComponent(deckUrl.trim())}`);
      const json = await res.json();
      if (json.error) {
        showToast(json.error, "error");
        setImporting(false);
        return;
      }
      const entry = {
        key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: json.name || "Imported Deck",
        main: groupIds(json.main || []),
        extra: groupIds(json.extra || []),
        side: groupIds(json.side || []),
      };
      setLibrary((prev) => {
        const next = [...prev, entry];
        saveLibraryToStorage(next);
        return next;
      });
      showToast(`「${entry.name}」を取り込みました`);
      setImportUrl("");
    } catch (e) {
      showToast(`取り込みに失敗しました(${e.message})`, "error");
    }
    setImporting(false);
  }

   async function bulkImportDecks(urls) {
    if (!urls.length) return;
    setImporting(true);
    const newEntries = [];
    for (const deckUrl of urls) {
      try {
        const res = await fetch(`${DECK_PROXY_URL}?url=${encodeURIComponent(deckUrl)}`);
        const json = await res.json();
        if (json.error) continue;
        newEntries.push({
          key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: json.name || "Imported Deck",
          main: groupIds(json.main || []),
          extra: groupIds(json.extra || []),
          side: groupIds(json.side || []),
        });
      } catch {
        /* このデッキだけスキップ */
      }
    }
    if (newEntries.length) {
      setLibrary((prev) => {
        const next = [...prev, ...newEntries];
        saveLibraryToStorage(next);
        return next;
      });
    }
    showToast(`${newEntries.length}/${urls.length}件のデッキを取り込みました`);
    setImporting(false);
  }
   async function browseCategory(formatName) {
    setImporting(true);
    let offset = 0;
    const limit = 50;
    let page = 0;
    const newEntries = [];
    while (page < 60) {
      let data;
      try {
        const res = await fetch(`${DECK_PROXY_URL}?browse=${encodeURIComponent(formatName)}&offset=${offset}&limit=${limit}`);
        data = await res.json();
      } catch (e) {
        showToast(`取得中にエラーが発生しました(${e.message})`, "error");
        break;
      }
      if (data.error || !data.decks || data.decks.length === 0) break;
      for (const d of data.decks) {
        newEntries.push({
          key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${page}_${newEntries.length}`,
          name: d.name,
          main: groupIds(d.main || []),
          extra: groupIds(d.extra || []),
          side: groupIds(d.side || []),
        });
      }
      showToast(`${formatName}: ${newEntries.length}件取得中...`);
      offset += data.decks.length;
      page++;
    }
    if (newEntries.length) {
      setLibrary((prev) => {
        const next = [...prev, ...newEntries];
        saveLibraryToStorage(next);
        return next;
      });
    }
    showToast(`${formatName}から${newEntries.length}件のデッキを取り込みました`);
    setImporting(false);
  }

   function buildYdkTextForEntry(entry) {
    const lines = ["#created by ygo-deckmaker"];
    lines.push("#main");
    entry.main.forEach((c) => {
      for (let i = 0; i < c.qty; i++) lines.push(String(c.id));
    });
    lines.push("#extra");
    entry.extra.forEach((c) => {
      for (let i = 0; i < c.qty; i++) lines.push(String(c.id));
    });
    lines.push("!side");
    entry.side.forEach((c) => {
      for (let i = 0; i < c.qty; i++) lines.push(String(c.id));
    });
    return lines.join("\n");
  }

  async function downloadLibraryAsZip() {
    if (!window.JSZip) {
      showToast("ZIP機能の読み込みに失敗しました。ページを再読み込みしてください", "error");
      return;
    }
    if (library.length === 0) {
      showToast("ライブラリが空です", "error");
      return;
    }
    const zip = new window.JSZip();
    const usedNames = new Set();
    library.forEach((entry) => {
      const base = (entry.name || "deck").replace(/[\\/:*?"<>|]/g, "_").trim() || "deck";
      let filename = `${base}.ydk`;
      let i = 2;
      while (usedNames.has(filename)) {
        filename = `${base}_${i}.ydk`;
        i++;
      }
      usedNames.add(filename);
      zip.file(filename, buildYdkTextForEntry(entry));
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "decks.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`${library.length}件のデッキをZIPでダウンロードしました`);
  }
   
  function removeFromLibrary(key) {
    setLibrary((prev) => {
      const next = prev.filter((d) => d.key !== key);
      saveLibraryToStorage(next);
      return next;
    });
  }

  function openLibraryDeck(entry) {
    const currentCount =
      deck.main.reduce((s, c) => s + c.qty, 0) +
      deck.extra.reduce((s, c) => s + c.qty, 0) +
      deck.side.reduce((s, c) => s + c.qty, 0);
    if (currentCount > 0 && !window.confirm(`「${entry.name}」を編集用に開きます。現在のデッキは上書きされます。よろしいですか?`)) {
      return;
    }
    setDeck({ main: entry.main, extra: entry.extra, side: entry.side });
    const ids = [...entry.main, ...entry.extra, ...entry.side].map((c) => c.id);
    fetchCardsByIds(ids);
    setLibraryOpen(false);
    setActiveZone("main");
    showToast(`「${entry.name}」を開きました`);
  }

  function buildYdkText() {
    const lines = ["#created by ygo-deckmaker"];
    lines.push("#main");
    deck.main.forEach((c) => {
      for (let i = 0; i < c.qty; i++) lines.push(String(c.id));
    });
    lines.push("#extra");
    deck.extra.forEach((c) => {
      for (let i = 0; i < c.qty; i++) lines.push(String(c.id));
    });
    lines.push("!side");
    deck.side.forEach((c) => {
      for (let i = 0; i < c.qty; i++) lines.push(String(c.id));
    });
    return lines.join("\n");
  }

  function buildTextList() {
    const nameOf = (id) => nameIndex?.get(id)?.ja || cardCache[id]?.name || `#${id}`;
    const sec = (label, arr) =>
      arr.length
        ? `【${label}】\n` + arr.map((c) => `${nameOf(c.id)} ×${c.qty}`).join("\n")
        : "";
    return [sec("メイン", deck.main), sec("エクストラ", deck.extra), sec("サイド", deck.side)]
      .filter(Boolean)
      .join("\n\n");
  }

  function downloadYdk() {
    const text = buildYdkText();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "deck.ydk";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("YDKファイルをダウンロードしました");
  }

  async function copyTextList() {
    const text = buildTextList();
    try {
      await navigator.clipboard.writeText(text);
      showToast("テキストをコピーしました");
    } catch {
      setExportText(text);
    }
  }

  const totals = useMemo(
    () => ({
      main: deck.main.reduce((s, c) => s + c.qty, 0),
      extra: deck.extra.reduce((s, c) => s + c.qty, 0),
      side: deck.side.reduce((s, c) => s + c.qty, 0),
    }),
    [deck]
  );

  const selectedCard = selectedCardId ? cardCache[selectedCardId] : null;
  const selectedInfo = selectedCardId ? nameIndex?.get(selectedCardId) : null;

  useEffect(() => {
    if (selectedCardId) fetchJaText(selectedCardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId]);

  return (
    <div className="flex flex-col h-full min-h-screen bg-gray-100" style={{ fontFamily: "system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif" }}>
      {/* ---------- ヘッダー ---------- */}
      <header className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-30 shadow">
        <div>
          <div className="font-bold text-lg leading-tight">デッキメーカー</div>
          <div className="text-xs text-gray-400">遊戯王 OCG / YGOProDeck連携</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleClearAll}
            className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
          >
            全削除
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-sm font-semibold"
          >
            保存
          </button>
        </div>
      </header>

      {fetchError && (
        <div className="bg-red-50 text-red-700 text-xs px-4 py-2 flex justify-between items-center gap-2">
          <span>{fetchError}</span>
          <button onClick={() => setFetchError(null)} className="flex-shrink-0 underline">
            閉じる
          </button>
        </div>
      )}


      {/* ---------- タブ ---------- */}
      <div className="bg-white border-b flex sticky z-20" style={{ top: "56px" }}>
        {ZONES.map((z) => (
          <button
            key={z.key}
            onClick={() => setActiveZone(z.key)}
            className={
              "flex-1 py-2.5 text-sm font-semibold border-b-2 " +
              (activeZone === z.key
                ? "border-teal-600 text-teal-700"
                : "border-transparent text-gray-500")
            }
          >
            {z.label} {totals[z.key]}
            {z.key === "main" && (
              <span className={totals.main < MAIN_RECOMMENDED_MIN ? "text-red-500" : "text-gray-400"}>
                {" "}
                / {MAIN_RECOMMENDED_MIN}
              </span>
            )}
            {z.key !== "main" && <span className="text-gray-400"> / {z.max}</span>}
          </button>
        ))}
      </div>

      {/* ---------- エクスポート行 ---------- */}
      <div className="bg-white border-b px-4 py-2 flex gap-2 text-xs flex-wrap">
        <button onClick={downloadYdk} className="px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50">
          YDKダウンロード
        </button>
        <button onClick={copyTextList} className="px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50">
          テキストをコピー
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50"
        >
          {importing ? "取込中..." : "YDKを取込"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".ydk"
          multiple
          className="hidden"
          onChange={handleImportFiles}
        />
        <button
          onClick={() => setLibraryOpen(true)}
          className="px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50"
        >
          ライブラリ {library.length > 0 ? `(${library.length})` : ""}
        </button>
      </div>

       <div className="bg-white border-b px-4 py-2 flex gap-2 text-xs flex-wrap">
        <span className="text-gray-400 self-center">カテゴリを一括取得:</span>
        <button
          onClick={() => browseCategory("Tournament Meta Decks OCG")}
          disabled={importing}
          className="px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          OCGメタデッキ
        </button>
        <button
          onClick={() => browseCategory("Master Duel Decks")}
          disabled={importing}
          className="px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          マスターデュエルデッキ
        </button>
      </div>

       <div className="bg-white border-b px-4 py-2 flex gap-2 text-xs">
        <select
          value={customFormat}
          onChange={(e) => setCustomFormat(e.target.value)}
          className="flex-1 border border-gray-300 rounded px-2 py-1"
        >
          <option value="">カテゴリを選択...</option>
          <option value="Tournament Meta Decks">Tournament Meta Decks</option>
          <option value="Tournament Meta Decks OCG">Tournament Meta Decks OCG</option>
          <option value="Tournament Meta Decks (Genesys)">Tournament Meta Decks (Genesys)</option>
          <option value="Tournament Meta Decks Worlds">Tournament Meta Decks Worlds</option>
          <option value="Tournament Meta Decks OCG (Asian-English)">Tournament Meta Decks OCG (Asian-English)</option>
          <option value="Meta Decks">Meta Decks</option>
          <option value="World Championship Decks">World Championship Decks</option>
          <option value="Non-Meta Decks">Non-Meta Decks</option>
          <option value="Anime Decks">Anime Decks</option>
          <option value="Fun/Casual Decks">Fun/Casual Decks</option>
          <option value="Theorycrafting Decks">Theorycrafting Decks</option>
          <option value="Master Duel Decks">Master Duel Decks</option>
          <option value="Common Charity Decks">Common Charity Decks</option>
          <option value="Domain Format Decks">Domain Format Decks</option>
          <option value="Edison Format">Edison Format</option>
          <option value="Goat Format">Goat Format</option>
          <option value="Worlds Format Decks">Worlds Format Decks</option>
          <option value="Trinity Format Decks">Trinity Format Decks</option>
          <option value="Speed Duel Decks">Speed Duel Decks</option>
        </select>
        <button
          onClick={() => browseCategory(customFormat)}
          disabled={importing || !customFormat.trim()}
          className="px-3 py-1 rounded bg-teal-600 text-white disabled:bg-gray-300"
        >
          このカテゴリを取得
        </button>
      </div>
       
       
       <div className="bg-white border-b px-4 py-2 flex gap-2 text-xs">
        <input
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          placeholder="YGOProDeckのデッキURLを貼り付け(https://ygoprodeck.com/deck/...)"
          className="flex-1 border border-gray-300 rounded px-2 py-1"
        />
        <button
          onClick={() => importFromDeckUrl(importUrl)}
          disabled={importing || !importUrl.trim()}
          className="px-3 py-1 rounded bg-teal-600 text-white disabled:bg-gray-300"
        >
          {importing ? "取込中..." : "URLから取込"}
        </button>
      </div>
       

      {/* ---------- デッキグリッド ---------- */}
      <main className="flex-1 overflow-y-auto p-3 pb-40">
        {deck[activeZone].length === 0 ? (
          <div className="text-center text-gray-400 text-sm mt-16">
            下の検索欄からカードを追加してください
          </div>
        ) : (
          <div className="grid grid-cols-10 sm:grid-cols-15 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2">
            {deck[activeZone].map((entry) => (
              <CardThumb
                key={entry.id}
                card={cardCache[entry.id]}
                jaName={nameIndex?.get(entry.id)?.ja}
                qty={entry.qty}
                onClick={() => setSelectedCardId(entry.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* ---------- 検索バー(下部固定) ---------- */}
      <div className="bg-white border-t sticky bottom-0 z-20 shadow-inner">
        {searchResults.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 py-2 border-b bg-gray-50">
            {searching && <div className="text-xs text-gray-400 self-center px-2">検索中...</div>}
            {searchResults.map((id) => (
              <div key={id} className="flex-shrink-0 w-16">
                <CardThumb
                  card={cardCache[id]}
                  jaName={nameIndex?.get(id)?.ja}
                  qty={totalCopies(id)}
                  small
                  onClick={() => addOneFromSearch(id)}
                  onLongPress={() => setSelectedCardId(id)}
                />
              </div>
            ))}
          </div>
        )}
        <div className="p-3 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="カード名で検索(漢字/ひらがな/カタカナ/English)"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* ---------- カード詳細モーダル ---------- */}
      {selectedCardId && (
        <CardDetailModal
          card={selectedCard}
          info={selectedInfo}
          jaText={jaTextCache[selectedCardId]}
          deck={deck}
          getQty={getQty}
          setQty={(zone, q) => setQty(zone, selectedCardId, q)}
          maxAllowed={maxAllowed(selectedCardId)}
          onBulkImportDecks={bulkImportDecks}
          onClose={() => setSelectedCardId(null)}
        />
      )}

      {/* ---------- ライブラリ(取り込んだYDKの一覧) ---------- */}
      {libraryOpen && (
        <LibraryPanel
          library={library}
          cardCache={cardCache}
          nameIndex={nameIndex}
          fetchCardsByIds={fetchCardsByIds}
          onOpenDeck={openLibraryDeck}
          onDownloadAll={downloadLibraryAsZip}
          onRemove={removeFromLibrary}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      {/* ---------- テキストコピーのフォールバック ---------- */}
      {exportText && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <div className="bg-white rounded-lg p-4 max-w-md w-full">
            <div className="font-semibold mb-2 text-sm">
              クリップボードにアクセスできませんでした。下のテキストを選択してコピーしてください。
            </div>
            <textarea
              readOnly
              className="w-full h-48 border rounded p-2 text-xs"
              value={exportText}
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={() => setExportText(null)}
              className="mt-3 w-full py-2 rounded bg-gray-800 text-white text-sm"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* ---------- トースト ---------- */}
      {toast && (
        <div
          className={
            "fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded text-white text-sm shadow-lg z-50 " +
            (toast.kind === "error" ? "bg-red-600" : "bg-gray-800")
          }
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- CardThumb --------------------------------- */

function CardThumb({ card, jaName, qty, onClick, small }) {
  if (!card) {
    return <div className="bg-gray-200 rounded animate-pulse" style={{ paddingBottom: "146%" }} />;
  }
  return (
    <button onClick={onClick} className="relative block w-full text-left">
      <img
        src={card.card_images?.[0]?.image_url_small}
        alt={jaName || card.name}
        className="w-full rounded shadow-sm border border-gray-200"
      />
      {qty > 0 && (
        <span
          className="absolute top-0.5 right-0.5 bg-teal-600 text-white font-bold rounded-full w-5 h-5 flex items-center justify-center shadow"
          style={{ fontSize: "10px" }}
        >
          {qty}
        </span>
      )}
      {!small && (
        <div className="text-xs text-gray-600 truncate mt-0.5">{jaName || card.name}</div>
      )}
    </button>
  );
}

/* --------------------------- CardDetailModal ------------------------------ */

function CardDetailModal({ card, info, jaText, getQty, setQty, maxAllowed, onClose, onBulkImportDecks }) {  if (!card) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center z-40"
        style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      >
        <div className="bg-white rounded-lg p-6 text-sm text-gray-500">読み込み中...</div>
      </div>
    );
  }
  const jaName = info?.ja || card.name;
  // jaText: undefined=取得中 / null=見つからず英語で代替 / string=日本語テキスト
  const displayText = jaText === undefined ? "読み込み中..." : jaText || card.desc;
  const badge = info ? limitLabel(info.limitOcg) : null;
  const zone = isExtraDeckType(card.type) ? "extra" : "main";

  const mainQty = getQty("main", card.id);
  const extraQty = getQty("extra", card.id);
  const sideQty = getQty("side", card.id);

  const searchName = encodeURIComponent(card.name);

   const [relatedDecks, setRelatedDecks] = useState(null);

  async function searchRelatedDecks() {
    if (!card.archetype) return;
    setRelatedDecks({ loading: true, decks: [], selected: new Set() });
    try {
      const res = await fetch(`${DECK_PROXY_URL}?archetype=${encodeURIComponent(card.archetype)}`);
      const data = await res.json();
      setRelatedDecks({ loading: false, decks: data.decks || [], selected: new Set() });
    } catch (e) {
      setRelatedDecks({ loading: false, decks: [], selected: new Set() });
    }
  }

  function toggleDeck(url) {
    setRelatedDecks((prev) => {
      const next = new Set(prev.selected);
      next.has(url) ? next.delete(url) : next.add(url);
      return { ...prev, selected: next };
    });
  }

  function toggleAllDecks() {
    setRelatedDecks((prev) => {
      const allSelected = prev.selected.size === prev.decks.length;
      return { ...prev, selected: allSelected ? new Set() : new Set(prev.decks.map((d) => d.url)) };
    });
  }

  return (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center z-40 p-0 sm:p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg overflow-y-auto"
        style={{ maxHeight: "90vh" }}
      >
        <div className="flex justify-between items-center px-4 py-3 border-b sticky top-0 bg-white">
          <div className="font-bold">{jaName}</div>
          <button onClick={onClose} className="text-gray-400 text-xl leading-none px-2">×</button>
        </div>

        <div className="p-4 flex gap-4">
          <img
            src={card.card_images?.[0]?.image_url}
            alt={jaName}
            className="w-32 rounded shadow flex-shrink-0"
          />
          <div className="text-xs text-gray-600 space-y-1 flex-1">
            <div>{card.type}</div>
            {card.race && <div>種族: {card.race}</div>}
            {typeof card.atk === "number" && (
              <div>ATK {card.atk} / DEF {card.def ?? "-"}</div>
            )}
            {card.level != null && <div>レベル/ランク: {card.level}</div>}
            {card.linkval != null && <div>リンク: {card.linkval}</div>}
            {badge && (
              <span className={`inline-block text-white text-xs px-2 py-0.5 rounded ${badge.cls}`}>
                {badge.text}
              </span>
            )}
          </div>
        </div>

        <div className="px-4 pb-3 text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">
          {displayText}
        </div>

        <div className="px-4 pb-4 space-y-3 border-t pt-3">
          <QtyRow label={zone === "extra" ? "エクストラ" : "メイン"} value={zone === "extra" ? extraQty : mainQty}
            onChange={(v) => setQty(zone, v)} max={maxAllowed} />
          <QtyRow label="サイド" value={sideQty} onChange={(v) => setQty("side", v)} max={maxAllowed} />
          <div className="text-xs text-gray-400">このカードの上限: デッキ全体で{maxAllowed}枚</div>
        </div>

         <div className="px-4 pb-4 border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">
              関連デッキ{card.archetype ? `(${card.archetype})` : ""}
            </div>
            {card.archetype && !relatedDecks && (
              <button onClick={searchRelatedDecks} className="text-xs px-2 py-1 rounded bg-teal-600 text-white">
                検索する
              </button>
            )}
          </div>
          {!card.archetype && (
            <div className="text-xs text-gray-400">このカードはテーマ情報を持っていないため検索できません</div>
          )}
          {relatedDecks?.loading && <div className="text-xs text-gray-400">検索中...</div>}
          {relatedDecks && !relatedDecks.loading && relatedDecks.decks.length === 0 && (
            <div className="text-xs text-gray-400">関連デッキが見つかりませんでした</div>
          )}
          {relatedDecks && relatedDecks.decks.length > 0 && (
            <>
              <div className="flex justify-between items-center mb-2">
                <button onClick={toggleAllDecks} className="text-xs underline text-teal-700">
                  {relatedDecks.selected.size === relatedDecks.decks.length ? "すべて解除" : "すべて選択"}
                </button>
                <button
                  disabled={relatedDecks.selected.size === 0}
                  onClick={() => onBulkImportDecks([...relatedDecks.selected])}
                  className="text-xs px-2 py-1 rounded bg-teal-600 text-white disabled:bg-gray-300"
                >
                  選択したデッキを取り込む({relatedDecks.selected.size})
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {relatedDecks.decks.map((d) => (
                  <label key={d.url} className="flex items-center gap-2 text-xs py-1 border-b">
                    <input
                      type="checkbox"
                      checked={relatedDecks.selected.has(d.url)}
                      onChange={() => toggleDeck(d.url)}
                    />
                    <span className="flex-1 truncate">{d.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
     
        <div className="px-4 pb-6 grid grid-cols-2 gap-2 text-xs">
          <a
            className="border rounded py-2 text-center hover:bg-gray-50"
            href={`https://yugioh-wiki.net/index.php?cmd=search&word=${searchName}&type=and`}
            target="_blank" rel="noreferrer"
          >
            カードWikiで見る
          </a>
          <a
            className="border rounded py-2 text-center hover:bg-gray-50"
            href={`https://www.youtube.com/results?search_query=${searchName}`}
            target="_blank" rel="noreferrer"
          >
            YouTubeで探す
          </a>
          <a
            className="border rounded py-2 text-center hover:bg-gray-50"
            href={`https://gachi-matome.com/?s=${searchName}`}
            target="_blank" rel="noreferrer"
          >
            関連記事を探す
          </a>
          <a
            className="border rounded py-2 text-center hover:bg-gray-50 bg-orange-50"
            href={LIMIT_REGULATION_URL}
            target="_blank" rel="noreferrer"
          >
            リミットレギュレーション
          </a>
        </div>
      </div>
    </div>
  );
}

function QtyRow({ label, value, onChange, max }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-3">
        <button
          onClick={() => onChange(Math.max(0, value - 1))}
          className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 text-lg leading-none"
        >
          −
        </button>
        <span className="w-6 text-center font-semibold">{value}</span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 text-lg leading-none"
        >
          +
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   LibraryPanel
   一括ダウンロードしたYDKファイル(取込済み)を一覧・プレビューするための
   閲覧専用パネル。プレビュー中に必要なカードデータだけ遅延取得する。
   -------------------------------------------------------------------------- */

function LibraryPanel({ library, cardCache, nameIndex, fetchCardsByIds, onOpenDeck, onRemove, onClose, onDownloadAll }) {  const [previewKey, setPreviewKey] = useState(null);
  const previewEntry = library.find((d) => d.key === previewKey) || null;

  useEffect(() => {
    if (!previewEntry) return;
    const ids = [...previewEntry.main, ...previewEntry.extra, ...previewEntry.side].map((c) => c.id);
    fetchCardsByIds(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const countOf = (d) =>
    d.main.reduce((s, c) => s + c.qty, 0) +
    d.extra.reduce((s, c) => s + c.qty, 0) +
    d.side.reduce((s, c) => s + c.qty, 0);

  return (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center z-40 p-0 sm:p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg overflow-y-auto"
        style={{ maxHeight: "90vh" }}
      >
        <div className="flex justify-between items-center px-4 py-3 border-b sticky top-0 bg-white">
          <div className="font-bold">
            {previewEntry ? previewEntry.name : `ライブラリ (${library.length}件)`}
          </div>
          <div className="flex items-center gap-3">
            {!previewEntry && library.length > 0 && (
              <button onClick={onDownloadAll} className="text-xs px-2 py-1 rounded bg-teal-600 text-white">
                全てZIPでダウンロード
              </button>
            )}
            {previewEntry && (
              <button onClick={() => setPreviewKey(null)} className="text-xs text-teal-700">
                ← 一覧に戻る
              </button>
            )}
            <button onClick={onClose} className="text-gray-400 text-xl leading-none px-2">×</button>
          </div>
        </div>

        {!previewEntry && (
          <div className="p-4">
            {library.length === 0 ? (
              <div className="text-center text-gray-400 text-sm py-10">
                まだデッキが取り込まれていません。「YDKを取込」からファイルを選択してください。
              </div>
            ) : (
              <div className="space-y-2">
                {library.map((d) => (
                  <div key={d.key} className="border rounded-lg p-3 flex items-center justify-between">
                    <button className="text-left flex-1" onClick={() => setPreviewKey(d.key)}>
                      <div className="text-sm font-semibold truncate">{d.name}</div>
                      <div className="text-xs text-gray-400">
                        計{countOf(d)}枚(メイン{d.main.reduce((s, c) => s + c.qty, 0)} / エクストラ
                        {d.extra.reduce((s, c) => s + c.qty, 0)} / サイド
                        {d.side.reduce((s, c) => s + c.qty, 0)})
                      </div>
                    </button>
                    <div className="flex gap-2 ml-2">
                      <button
                        onClick={() => onOpenDeck(d)}
                        className="text-xs px-2 py-1 rounded bg-teal-600 text-white"
                      >
                        開く
                      </button>
                      <button
                        onClick={() => onRemove(d.key)}
                        className="text-xs px-2 py-1 rounded border border-gray-300"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {previewEntry && (
          <div className="p-4">
            <button
              onClick={() => onOpenDeck(previewEntry)}
              className="w-full mb-3 py-2 rounded bg-teal-600 text-white text-sm font-semibold"
            >
              このデッキを編集用に開く
            </button>
            {[
              { label: "メイン", arr: previewEntry.main },
              { label: "エクストラ", arr: previewEntry.extra },
              { label: "サイド", arr: previewEntry.side },
            ].map(
              (sec) =>
                sec.arr.length > 0 && (
                  <div key={sec.label} className="mb-4">
                    <div className="text-xs font-semibold text-gray-500 mb-1">{sec.label}</div>
                    <div className="grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-1.5">
                      {sec.arr.map((c) => (
                        <CardThumb
                          key={c.id}
                          card={cardCache[c.id]}
                          jaName={nameIndex?.get(c.id)?.ja}
                          qty={c.qty}
                          small
                          onClick={() => {}}
                        />
                      ))}
                    </div>
                  </div>
                )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
