import { useState, useEffect, useCallback, useRef } from "react";

// ── Storage (localStorage) ──
const get = (k, d=null) => { try { const v=localStorage.getItem(k); return v?JSON.parse(v):d; } catch{ return d; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){ console.error(e); } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ── Claude API ──
async function askClaude(apiKey, messages, sys) {
  const body = { model: "claude-haiku-4-5-20251001", max_tokens: 4096, messages };
  if (sys) body.system = sys;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`API Error ${res.status}: ${e}`); }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function extractTextFromFile(key, base64, mediaType) {
  return askClaude(key, [{ role: "user", content: [
    { type: mediaType.startsWith("application/pdf") ? "document" : "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text: "この画像/文書からすべてのテキスト・表・内容を正確に抽出してください。章・節の見出しがあればそのまま保持。ページ番号があれば[p.XX]で含めてください。元テキストだけ出力。" },
  ]}]);
}

async function detectStructure(key, fullText) {
  const sys = `教材構造分析AI。テキストから章・節を自動判別。見出しの体裁、ページ番号、文脈の切り替わりから判断。ページをまたいでも文脈から同一セクションにまとめる。明確な構造がなければテーマ変化から論理分割。JSON形式のみ出力。前置き不要。
{"chapters":[{"title":"章タイトル","sections":[{"title":"節タイトル","content":"本文"}]}]}`;
  const raw = await askClaude(key, [{ role: "user", content: fullText }], sys);
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return { chapters: [{ title: "第1章", sections: [{ title: "第1節", content: fullText }] }] }; }
}

async function extractKeywords(key, text) {
  const sys = `教材から理解の核となるキーワードを5〜10個抽出。JSON配列のみ出力。例:["KW1","KW2"]`;
  const raw = await askClaude(key, [{ role: "user", content: text }], sys);
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return raw.split(/[,、\n]/).map(s => s.replace(/["\[\]]/g, "").trim()).filter(Boolean); }
}

async function generateCloze(key, text) {
  const sys = `学習用穴埋め問題作成AI。教材から用語・数値・定義など正確に覚えるべき箇所を穴埋め問題5〜8問作成。JSON配列のみ出力。
[{"question":"筋肥大に必要な負荷は1RMの____％以上","answer":"65","hint":"数値"}]`;
  const raw = await askClaude(key, [{ role: "user", content: text }], sys);
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return []; }
}

async function evaluateRecall(key, material, keywords, shownKws, userExp, level) {
  const ld = ["全キーワード表示","キーワード60%表示","キーワード30%表示","キーワードなし"][level] || "";
  const sys = `学習評価AI。難易度:${ld}（高いほど寛大に）。JSON形式のみ出力。
{"score":0,"correct_understanding":"","missing_points":"","misconceptions":"特になし"}`;
  const raw = await askClaude(key, [{ role: "user", content: `【教材】\n${material}\n\n【全KW】\n${keywords.join(", ")}\n\n【表示KW】\n${shownKws.join(", ")||"なし"}\n\n【説明】\n${userExp}` }], sys);
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return { score: 0, correct_understanding: "評価エラー", missing_points: raw, misconceptions: "" }; }
}

// ── SRS ──
function calcSRS(prev, score) {
  let { interval=1, ease=2.5, level=0 } = prev || {};
  if (score>=80) { interval=interval<1?1:Math.round(interval*ease); ease=Math.min(3,ease+.1); level=Math.min(3,level+1); }
  else if (score>=50) { interval=Math.max(1,Math.round(interval*.8)); }
  else { interval=1; ease=Math.max(1.3,ease-.2); level=Math.max(0,level-1); }
  return { interval, ease, level, nextReview: Date.now()+interval*864e5 };
}
function getShownKws(kws, level) {
  const r=[1,.6,.3,0][level]; const n=Math.max(0,Math.round(kws.length*r));
  if(!n) return []; return [...kws].sort(()=>Math.random()-.5).slice(0,n);
}

const LVL=["Lv.1 全表示","Lv.2 部分","Lv.3 最小","Lv.4 フリー"];
const LVLC=["#60a5fa","#a78bfa","#f59e0b","#f87171"];

// ── Micro Components ──
function Spinner({text}){return<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,padding:32}}><div style={{width:36,height:36,border:"3px solid #334155",borderTop:"3px solid #f59e0b",borderRadius:"50%",animation:"spin .8s linear infinite"}}/><span style={{color:"#94a3b8",fontSize:14}}>{text}</span></div>}
function SB({score,size=48}){const c=score>=80?"#34d399":score>=50?"#fbbf24":"#f87171";return<span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:size,height:size,borderRadius:"50%",fontSize:size*.33,fontWeight:700,border:`3px solid ${c}`,color:c,fontFamily:"monospace"}}>{score}</span>}
function LB({level}){return<span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:12,background:LVLC[level]+"22",color:LVLC[level]}}>{LVL[level]}</span>}
function DB({nr}){if(!nr)return null;const d=nr-Date.now();if(d<=0)return<span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:12,background:"#f8717122",color:"#f87171"}}>復習時</span>;return<span style={{fontSize:11,padding:"2px 8px",borderRadius:12,background:"#1e293b",color:"#64748b"}}>{Math.ceil(d/864e5)}日後</span>}

const S={
  app:{minHeight:"100vh",background:"#0c0f1a",color:"#e2e8f0",maxWidth:520,margin:"0 auto",padding:"0 16px 80px"},
  hdr:{padding:"20px 0 12px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #1e293b",marginBottom:20},
  bk:{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:20,padding:0},
  btn:a=>({padding:"10px 20px",borderRadius:10,border:"none",cursor:"pointer",fontWeight:600,fontSize:14,fontFamily:"inherit",background:a?"#f59e0b":"#1e293b",color:a?"#0c0f1a":"#e2e8f0"}),
  bsm:a=>({padding:"6px 14px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",background:a?"#f59e0b":"#1e293b",color:a?"#0c0f1a":"#94a3b8"}),
  card:{background:"#131729",borderRadius:14,padding:16,marginBottom:10,border:"1px solid #1e293b"},
  inp:{width:"100%",padding:"10px 14px",borderRadius:10,border:"1px solid #334155",background:"#0f1225",color:"#e2e8f0",fontSize:14,fontFamily:"inherit",outline:"none",boxSizing:"border-box"},
  ta:{width:"100%",padding:"12px 14px",borderRadius:10,border:"1px solid #334155",background:"#0f1225",color:"#e2e8f0",fontSize:14,fontFamily:"inherit",outline:"none",resize:"vertical",minHeight:120,boxSizing:"border-box"},
  tag:{display:"inline-block",padding:"4px 12px",borderRadius:20,fontSize:13,background:"#1e293b",color:"#f59e0b",fontWeight:600,margin:"3px 4px 3px 0"},
  lbl:{fontSize:12,color:"#94a3b8",fontWeight:600,marginBottom:6,display:"block"},
  nav:{position:"fixed",bottom:0,left:0,right:0,background:"#0c0f1a",borderTop:"1px solid #1e293b",display:"flex",justifyContent:"center",gap:6,padding:"10px 12px",zIndex:10},
  nvb:a=>({flex:1,maxWidth:120,padding:"8px 0",borderRadius:10,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",background:a?"#1e293b":"transparent",color:a?"#f59e0b":"#64748b"}),
  emp:{textAlign:"center",padding:40,color:"#475569",fontSize:14},
  fb:c=>({background:"#131729",borderRadius:12,padding:14,marginBottom:10,borderLeft:`3px solid ${c}`}),
};

// ═══════════════════════════════
// MAIN APP
// ═══════════════════════════════
export default function App() {
  const [apiKey, setApiKey] = useState(() => get("rf:apikey", ""));
  const [keyInput, setKeyInput] = useState("");
  const [view, setView] = useState("home");
  const [materials, setMaterials] = useState(() => get("rf:mat", []));
  const [attempts, setAttempts] = useState(() => get("rf:att", []));
  const [proc, setProc] = useState(false);
  const [procMsg, setPM] = useState("");
  const fRef = useRef();

  const [selMat, setSM] = useState(null);
  const [selChap, setSC] = useState(null);
  const [selSec, setSS] = useState(null);

  const [addTitle, setAT] = useState("");
  const [addMode, setAMode] = useState("smart");
  const [addChapters, setACh] = useState([{id:uid(),title:"第1章",sections:[{id:uid(),title:"第1節",content:""}]}]);
  const [addTarget, setATgt] = useState({ci:0,si:0});
  const [smartTexts, setSTx] = useState([]);
  const [smartPreview, setSPv] = useState(null);

  const [addChPreview, setACP] = useState(null);
  const addChRef = useRef();

  const [userAns, setUA] = useState("");
  const [shownKws, setSKw] = useState([]);
  const [lastResult, setLR] = useState(null);

  const [clozeQs, setCQ] = useState([]);
  const [clozeAs, setCA] = useState({});
  const [clozeResult, setCR] = useState(null);

  const saveMat = useCallback(m => { setMaterials(m); set("rf:mat", m); }, []);
  const saveAtt = useCallback(a => { setAttempts(a); set("rf:att", a); }, []);

  const K = apiKey; // shorthand

  // ── API Key Screen ──
  if (!apiKey) return (
    <div style={S.app}>
      <div style={{ padding: "60px 0", textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 800, color: "#f59e0b", marginBottom: 8 }}>⚡ RecallForge</div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 32 }}>説明できなければ、理解していない</div>
        <div style={S.card}>
          <label style={{ ...S.lbl, textAlign: "left" }}>Anthropic APIキーを入力</label>
          <input style={{ ...S.inp, marginBottom: 12 }} type="password" value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="sk-ant-..." />
          <div style={{ fontSize: 11, color: "#475569", marginBottom: 16, textAlign: "left", lineHeight: 1.6 }}>
            APIキーはこのブラウザのlocalStorageにのみ保存されます。サーバーには送信されません。
          </div>
          <button style={{ ...S.btn(true), width: "100%", opacity: keyInput.trim() ? 1 : .4 }} disabled={!keyInput.trim()} onClick={() => { const k = keyInput.trim(); set("rf:apikey", k); setApiKey(k); }}>
            始める
          </button>
        </div>
      </div>
    </div>
  );

  // ── Handlers ──
  const handleSmartFile = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setProc(true); setPM("ファイルを読み取り中...");
    try {
      const b64 = await new Promise((r, j) => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(",")[1]); rd.onerror = () => j(new Error("fail")); rd.readAsDataURL(file); });
      const text = await extractTextFromFile(K, b64, file.type || "image/png");
      setSTx(p => [...p, { name: file.name, text }]);
    } catch (err) { alert("読み取り失敗: " + err.message); }
    setProc(false); if (fRef.current) fRef.current.value = "";
  };

  const handleDetect = async () => {
    if (!smartTexts.length) return;
    setProc(true); setPM("章・節を自動判別中...");
    try {
      const combined = smartTexts.map((t, i) => `--- ファイル${i+1}: ${t.name} ---\n${t.text}`).join("\n\n");
      setSPv(await detectStructure(K, combined));
    } catch (err) { alert("構造判別失敗: " + err.message); }
    setProc(false);
  };

  const handleSmartRegister = async () => {
    if (!smartPreview) return;
    setProc(true); setPM("キーワードを抽出中...");
    try {
      const chapters = [];
      for (const ch of smartPreview.chapters) {
        const secs = [];
        for (const sec of ch.sections) {
          if (!sec.content?.trim()) continue;
          setPM(`KW抽出: ${ch.title} > ${sec.title}`);
          const kws = await extractKeywords(K, sec.content.trim());
          secs.push({ id: uid(), title: sec.title, content: sec.content.trim(), keywords: kws, srs: { interval: 0, ease: 2.5, level: 0, nextReview: 0 } });
        }
        if (secs.length) chapters.push({ id: uid(), title: ch.title, sections: secs });
      }
      saveMat([{ id: uid(), title: addTitle.trim() || "無題の教材", chapters, createdAt: Date.now() }, ...materials]);
      setAT(""); setSTx([]); setSPv(null); setView("home");
    } catch (err) { alert("登録失敗: " + err.message); }
    setProc(false);
  };

  const handleManualFile = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setProc(true); setPM("ファイルを読み取り中...");
    try {
      const b64 = await new Promise((r, j) => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(",")[1]); rd.onerror = () => j(new Error("fail")); rd.readAsDataURL(file); });
      const text = await extractTextFromFile(K, b64, file.type || "image/png");
      const { ci, si } = addTarget;
      setACh(p => { const n = JSON.parse(JSON.stringify(p)); n[ci].sections[si].content = (n[ci].sections[si].content ? n[ci].sections[si].content + "\n\n" : "") + text; return n; });
    } catch (err) { alert("読み取り失敗: " + err.message); }
    setProc(false); if (fRef.current) fRef.current.value = "";
  };

  const handleManualRegister = async () => {
    const has = addChapters.some(c => c.sections.some(s => s.content.trim()));
    if (!has) return;
    setProc(true); setPM("キーワードを抽出中...");
    try {
      const chapters = [];
      for (const ch of addChapters) {
        const secs = [];
        for (const sec of ch.sections) {
          if (!sec.content.trim()) continue;
          setPM(`KW抽出: ${ch.title} > ${sec.title}`);
          const kws = await extractKeywords(K, sec.content.trim());
          secs.push({ id: uid(), title: sec.title, content: sec.content.trim(), keywords: kws, srs: { interval: 0, ease: 2.5, level: 0, nextReview: 0 } });
        }
        if (secs.length) chapters.push({ id: uid(), title: ch.title, sections: secs });
      }
      saveMat([{ id: uid(), title: addTitle.trim() || "無題の教材", chapters, createdAt: Date.now() }, ...materials]);
      setAT(""); setACh([{ id: uid(), title: "第1章", sections: [{ id: uid(), title: "第1節", content: "" }] }]); setView("home");
    } catch (err) { alert("登録失敗: " + err.message); }
    setProc(false);
  };

  const handleAddChapterFile = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setProc(true); setPM("ファイルを読み取り中...");
    try {
      const b64 = await new Promise((r, j) => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(",")[1]); rd.onerror = () => j(new Error("fail")); rd.readAsDataURL(file); });
      const text = await extractTextFromFile(K, b64, file.type || "image/png");
      setPM("章・節を自動判別中...");
      setACP(await detectStructure(K, text));
    } catch (err) { alert("読み取り失敗: " + err.message); }
    setProc(false); if (addChRef.current) addChRef.current.value = "";
  };

  const handleAddChapterRegister = async () => {
    if (!addChPreview || !selMat) return;
    setProc(true); setPM("キーワードを抽出中...");
    try {
      const newChapters = [];
      for (const ch of addChPreview.chapters) {
        const secs = [];
        for (const sec of ch.sections) {
          if (!sec.content?.trim()) continue;
          setPM(`KW抽出: ${ch.title} > ${sec.title}`);
          const kws = await extractKeywords(K, sec.content.trim());
          secs.push({ id: uid(), title: sec.title, content: sec.content.trim(), keywords: kws, srs: { interval: 0, ease: 2.5, level: 0, nextReview: 0 } });
        }
        if (secs.length) newChapters.push({ id: uid(), title: ch.title, sections: secs });
      }
      const updated = materials.map(m => m.id !== selMat.id ? m : { ...m, chapters: [...m.chapters, ...newChapters] });
      saveMat(updated);
      setSM(updated.find(m => m.id === selMat.id));
      setACP(null);
      setView("chapters");
    } catch (err) { alert("登録失敗: " + err.message); }
    setProc(false);
  };

  const startRecall = (mat, chap, sec) => { setSM(mat); setSC(chap); setSS(sec); setSKw(getShownKws(sec.keywords, sec.srs?.level || 0)); setUA(""); setView("recall"); };

  const startCloze = async (mat, chap, sec) => {
    setSM(mat); setSC(chap); setSS(sec);
    setProc(true); setPM("穴埋め問題を生成中...");
    try { setCQ(await generateCloze(K, sec.content)); setCA({}); setCR(null); setView("cloze"); }
    catch (err) { alert("生成失敗: " + err.message); }
    setProc(false);
  };

  const submitRecall = async () => {
    if (!userAns.trim() || !selSec) return;
    setProc(true); setPM("AIが評価中...");
    try {
      const lv = selSec.srs?.level || 0;
      const result = await evaluateRecall(K, selSec.content, selSec.keywords, shownKws, userAns.trim(), lv);
      const newSRS = calcSRS(selSec.srs, result.score);
      const updated = materials.map(m => m.id !== selMat.id ? m : { ...m, chapters: m.chapters.map(c => c.id !== selChap.id ? c : { ...c, sections: c.sections.map(s => s.id === selSec.id ? { ...s, srs: newSRS } : s) }) });
      saveMat(updated);
      const uSec = updated.find(m => m.id === selMat.id)?.chapters.find(c => c.id === selChap.id)?.sections.find(s => s.id === selSec.id);
      if (uSec) setSS(uSec);
      const att = { id: uid(), materialId: selMat.id, materialTitle: selMat.title, chapterTitle: selChap.title, sectionId: selSec.id, sectionTitle: selSec.title, mode: "explain", userExplanation: userAns.trim(), level: lv, shownKeywords: shownKws, ...result, srs: newSRS, createdAt: Date.now() };
      saveAtt([att, ...attempts]);
      setLR(att); setView("result");
    } catch (err) { alert("評価失敗: " + err.message); }
    setProc(false);
  };

  const submitCloze = () => {
    let correct = 0;
    const results = clozeQs.map((q, i) => {
      const ua = (clozeAs[i] || "").trim().toLowerCase();
      const ans = q.answer.trim().toLowerCase();
      const ok = ua === ans || (ans.includes(ua) && ua.length > 0);
      if (ok) correct++;
      return { ...q, userAnswer: clozeAs[i] || "", correct: ok };
    });
    const score = Math.round((correct / clozeQs.length) * 100);
    const newSRS = calcSRS(selSec.srs, score);
    const updated = materials.map(m => m.id !== selMat.id ? m : { ...m, chapters: m.chapters.map(c => c.id !== selChap.id ? c : { ...c, sections: c.sections.map(s => s.id === selSec.id ? { ...s, srs: newSRS } : s) }) });
    saveMat(updated);
    const att = { id: uid(), materialId: selMat.id, materialTitle: selMat.title, chapterTitle: selChap.title, sectionId: selSec.id, sectionTitle: selSec.title, mode: "cloze", score, clozeResults: results, srs: newSRS, createdAt: Date.now() };
    saveAtt([att, ...attempts]);
    setCR({ score, results, srs: newSRS }); setView("cloze-result");
  };

  const deleteMat = id => { if (!confirm("削除？")) return; saveMat(materials.filter(m => m.id !== id)); saveAtt(attempts.filter(a => a.materialId !== id)); };
  const getAllSecs = mat => { const o = []; for (const c of mat.chapters) for (const s of c.sections) o.push({ ...s, chapterTitle: c.title, chapterId: c.id }); return o; };
  const getDue = () => { const now = Date.now(), d = []; for (const m of materials) for (const c of m.chapters) for (const s of c.sections) if (!s.referenceOnly && (!s.srs?.nextReview || s.srs.nextReview <= now)) d.push({ mat: m, chap: c, sec: s }); return d; };

  const OV = proc && <div style={{ position: "fixed", inset: 0, background: "rgba(12,15,26,.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}><Spinner text={procMsg} /></div>;
  const NV = v => <div style={S.nav}><button style={S.nvb(v==="home")} onClick={()=>setView("home")}>📚 教材</button><button style={S.nvb(v==="review")} onClick={()=>setView("review")}>📊 履歴</button><button style={S.nvb(v==="due")} onClick={()=>setView("due")}>🔔 要復習</button><button style={S.nvb(v==="settings")} onClick={()=>setView("settings")}>⚙️</button></div>;

  // ═══════ SETTINGS ═══════
  if (view === "settings") return (
    <div style={S.app}>{OV}
      <div style={S.hdr}><div style={{ fontSize: 18, fontWeight: 700 }}>⚙️ 設定</div></div>
      <div style={S.card}>
        <label style={S.lbl}>APIキー</label>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>現在のキー: sk-ant-...{apiKey.slice(-6)}</div>
        <button style={{ ...S.bsm(), color: "#f87171" }} onClick={() => { if (confirm("APIキーをリセットしますか？")) { localStorage.removeItem("rf:apikey"); setApiKey(""); } }}>APIキーをリセット</button>
      </div>
      <div style={S.card}>
        <label style={S.lbl}>データ管理</label>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={S.bsm()} onClick={() => {
            const data = { materials, attempts, exportedAt: Date.now() };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "recallforge-backup.json"; a.click();
          }}>📥 バックアップ</button>
          <button style={S.bsm()} onClick={() => {
            const input = document.createElement("input"); input.type = "file"; input.accept = ".json";
            input.onchange = e => {
              const f = e.target.files?.[0]; if (!f) return;
              const r = new FileReader(); r.onload = () => {
                try { const d = JSON.parse(r.result); if (d.materials) saveMat(d.materials); if (d.attempts) saveAtt(d.attempts); alert("復元しました"); }
                catch { alert("ファイル形式エラー"); }
              }; r.readAsText(f);
            }; input.click();
          }}>📤 復元</button>
        </div>
      </div>
      {NV("settings")}
    </div>
  );

  // ═══════ HOME ═══════
  if (view === "home") { const dc = getDue().length; return (
    <div style={S.app}>{OV}
      <div style={S.hdr}><div><div style={{ fontSize: 22, fontWeight: 800, color: "#f59e0b" }}>⚡ RecallForge</div><div style={{ fontSize: 11, color: "#64748b" }}>説明できなければ、理解していない</div></div></div>
      {dc > 0 && <div style={{ ...S.card, background: "#1e1b4b", borderColor: "#312e81", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }} onClick={() => setView("due")}><span style={{ fontSize: 24 }}>🔔</span><div><div style={{ fontWeight: 700, fontSize: 14 }}>復習が必要</div><div style={{ fontSize: 12, color: "#818cf8" }}>{dc}件</div></div></div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontSize: 14, color: "#94a3b8" }}>教材 ({materials.length})</span>
        <button style={S.btn(true)} onClick={() => { setAT(""); setAMode("smart"); setSTx([]); setSPv(null); setACh([{ id: uid(), title: "第1章", sections: [{ id: uid(), title: "第1節", content: "" }] }]); setView("add"); }}>＋ 追加</button>
      </div>
      {materials.length === 0 ? <div style={S.emp}><div style={{ fontSize: 32, marginBottom: 12 }}>📚</div>教材を追加して学習を始めましょう</div> :
        materials.map(m => { const as = getAllSecs(m); const avgs = attempts.filter(a => a.materialId === m.id); const sc = avgs.length ? Math.round(avgs.reduce((s, a) => s + a.score, 0) / avgs.length) : null; return (
          <div key={m.id} style={{ ...S.card, cursor: "pointer" }} onClick={() => { setSM(m); setView("chapters"); }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{m.title}</div><div style={{ fontSize: 12, color: "#64748b" }}>{m.chapters.length}章 · {as.length}節</div></div>
              {sc !== null && <SB score={sc} />}<span style={{ color: "#475569", fontSize: 18, marginLeft: 8 }}>›</span>
            </div></div>); })}
      {NV("home")}
    </div>); }

  // ═══════ CHAPTERS ═══════
  if (view === "chapters" && selMat) { const mat = materials.find(m => m.id === selMat.id) || selMat; return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => setView("home")}>←</button><div><div style={{ fontSize: 18, fontWeight: 700 }}>{mat.title}</div></div><div style={{ marginLeft: "auto", display: "flex", gap: 8 }}><button style={S.bsm(true)} onClick={() => { setACP(null); setSM(mat); setView("add-chapter"); }}>＋ 章を追加</button><button style={{ ...S.bsm(), color: "#f87171" }} onClick={() => { deleteMat(mat.id); setView("home"); }}>削除</button></div></div>
      {mat.chapters.map(ch => { const ca = attempts.filter(a => ch.sections.some(s => s.id === a.sectionId)); const avg = ca.length ? Math.round(ca.reduce((s, a) => s + a.score, 0) / ca.length) : null; return (
        <div key={ch.id} style={{ ...S.card, cursor: "pointer" }} onClick={() => { setSM(mat); setSC(ch); setView("sections"); }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 15 }}>{ch.title}</div><div style={{ fontSize: 12, color: "#64748b" }}>{ch.sections.length}節</div></div>{avg !== null && <SB score={avg} size={40} />}<span style={{ color: "#475569", fontSize: 18, marginLeft: 8 }}>›</span></div></div>); })}
      {NV("home")}
    </div>); }

  // ═══════ SECTIONS ═══════
  if (view === "sections" && selMat && selChap) { const mat = materials.find(m => m.id === selMat.id) || selMat; const chap = mat.chapters.find(c => c.id === selChap.id) || selChap;
    const toggleRef = (secId) => {
      const updated = materials.map(m => m.id !== mat.id ? m : { ...m, chapters: m.chapters.map(c => c.id !== chap.id ? c : { ...c, sections: c.sections.map(s => s.id === secId ? { ...s, referenceOnly: !s.referenceOnly } : s) }) });
      saveMat(updated);
    };
    return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => { setSC(null); setView("chapters"); }}>←</button><div><div style={{ fontSize: 18, fontWeight: 700 }}>{chap.title}</div><div style={{ fontSize: 12, color: "#64748b" }}>{mat.title}</div></div></div>
      {chap.sections.map(sec => { const sa = attempts.filter(a => a.sectionId === sec.id); const best = sa.length ? Math.max(...sa.map(a => a.score)) : null; const isRef = !!sec.referenceOnly; return (
        <div key={sec.id} style={{ ...S.card, opacity: isRef ? 0.75 : 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{sec.title}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {!isRef && <><LB level={sec.srs?.level || 0} /><DB nr={sec.srs?.nextReview} /></>}
                {isRef && <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 12, background: "#1e293b", color: "#64748b" }}>📖 参照用</span>}
              </div>
            </div>
            {!isRef && best !== null && <SB score={best} size={40} />}
          </div>
          {!isRef && <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10, marginTop: 8 }}>{sec.keywords.map((kw, i) => <span key={i} style={{ ...S.tag, fontSize: 11, padding: "2px 10px" }}>{kw}</span>)}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={{ ...S.bsm(), background: "#0f2d1a", color: "#4ade80" }} onClick={() => { setSS(sec); setView("source"); }}>📖 原文</button>
            {!isRef && <>
              <button style={S.btn(true)} onClick={() => startRecall(mat, chap, sec)}>📝 説明</button>
              <button style={{ ...S.btn(), background: "#312e81", color: "#c4b5fd" }} onClick={() => startCloze(mat, chap, sec)}>🧩 精密</button>
            </>}
            <button style={{ ...S.bsm(), marginLeft: "auto", color: isRef ? "#f59e0b" : "#64748b" }} onClick={() => toggleRef(sec.id)}>{isRef ? "復習に含める" : "参照用にする"}</button>
          </div></div>); })}
      {NV("home")}
    </div>); }

  // ═══════ ADD ═══════
  if (view === "add") {
    const addCh = () => setACh(p => [...p, { id: uid(), title: `第${p.length + 1}章`, sections: [{ id: uid(), title: "第1節", content: "" }] }]);
    const addSec = ci => setACh(p => { const n = JSON.parse(JSON.stringify(p)); n[ci].sections.push({ id: uid(), title: `第${n[ci].sections.length + 1}節`, content: "" }); return n; });
    const uChT = (ci, v) => setACh(p => { const n = [...p]; n[ci] = { ...n[ci], title: v }; return n; });
    const uSeT = (ci, si, v) => setACh(p => { const n = JSON.parse(JSON.stringify(p)); n[ci].sections[si].title = v; return n; });
    const uSeC = (ci, si, v) => setACh(p => { const n = JSON.parse(JSON.stringify(p)); n[ci].sections[si].content = v; return n; });
    const rmCh = ci => { if (addChapters.length <= 1) return; setACh(p => p.filter((_, i) => i !== ci)); };
    const rmSe = (ci, si) => { if (addChapters[ci].sections.length <= 1) return; setACh(p => { const n = JSON.parse(JSON.stringify(p)); n[ci].sections.splice(si, 1); return n; }); };
    const hasC = addChapters.some(c => c.sections.some(s => s.content.trim()));
    return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => setView("home")}>←</button><div style={{ fontSize: 18, fontWeight: 700 }}>教材を追加</div></div>
      <div style={{ marginBottom: 16 }}><label style={S.lbl}>教材タイトル</label><input style={S.inp} value={addTitle} onChange={e => setAT(e.target.value)} placeholder="例：NSCA パーソナルトレーナー" /></div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button style={S.bsm(addMode === "smart")} onClick={() => setAMode("smart")}>🤖 自動判別</button>
        <button style={S.bsm(addMode === "manual")} onClick={() => setAMode("manual")}>✏️ 手動入力</button>
      </div>
      {addMode === "smart" ? (
        <div>
          <div style={{ border: "2px dashed #334155", borderRadius: 14, padding: 24, textAlign: "center", cursor: "pointer", color: "#64748b", fontSize: 14, background: "#0f1225", marginBottom: 12 }} onClick={() => fRef.current?.click()}>
            <div style={{ fontSize: 28, marginBottom: 6 }}>📄</div>ファイルを追加（複数OK）<br /><span style={{ fontSize: 11, color: "#475569" }}>PDF / 画像 / スクショ</span>
          </div>
          <input ref={fRef} type="file" accept="image/*,.pdf,application/pdf" style={{ display: "none" }} onChange={handleSmartFile} />
          {smartTexts.length > 0 && <div style={{ marginBottom: 12 }}>
            <label style={S.lbl}>読み込み済み ({smartTexts.length})</label>
            {smartTexts.map((t, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", background: "#1e293b", borderRadius: 8, marginBottom: 4, fontSize: 13 }}><span>📎 {t.name}</span><button style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer" }} onClick={() => setSTx(p => p.filter((_, j) => j !== i))}>✕</button></div>)}
            <button style={{ ...S.btn(true), width: "100%", marginTop: 8 }} onClick={handleDetect}>🔍 章・節を自動判別</button>
          </div>}
          {smartPreview && <div style={{ marginBottom: 16 }}>
            <label style={S.lbl}>検出された構造</label>
            {smartPreview.chapters.map((ch, ci) => <div key={ci} style={{ ...S.card, marginBottom: 8 }}>
              <input style={{ ...S.inp, fontWeight: 700, marginBottom: 8 }} value={ch.title} onChange={e => { const n = JSON.parse(JSON.stringify(smartPreview)); n.chapters[ci].title = e.target.value; setSPv(n); }} />
              {ch.sections.map((sec, si) => <div key={si} style={{ background: "#0f1225", borderRadius: 8, padding: 10, marginBottom: 6, border: "1px solid #1e293b" }}>
                <input style={{ ...S.inp, fontSize: 13, marginBottom: 6 }} value={sec.title} onChange={e => { const n = JSON.parse(JSON.stringify(smartPreview)); n.chapters[ci].sections[si].title = e.target.value; setSPv(n); }} />
                <div style={{ fontSize: 12, color: "#64748b", maxHeight: 60, overflow: "hidden" }}>{sec.content?.slice(0, 150)}...</div>
              </div>)}
            </div>)}
            <button style={{ ...S.btn(true), width: "100%" }} onClick={handleSmartRegister}>キーワード抽出して登録</button>
          </div>}
        </div>
      ) : (
        <div>
          {addChapters.map((ch, ci) => <div key={ch.id} style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
              <input style={{ ...S.inp, fontWeight: 700, flex: 1 }} value={ch.title} onChange={e => uChT(ci, e.target.value)} />
              {addChapters.length > 1 && <button style={{ ...S.bsm(), color: "#f87171" }} onClick={() => rmCh(ci)}>✕</button>}
            </div>
            {ch.sections.map((sec, si) => <div key={sec.id} style={{ background: "#0f1225", borderRadius: 10, padding: 12, marginBottom: 8, border: "1px solid #1e293b" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}><input style={{ ...S.inp, fontSize: 13, flex: 1 }} value={sec.title} onChange={e => uSeT(ci, si, e.target.value)} />{ch.sections.length > 1 && <button style={{ ...S.bsm(), color: "#f87171", fontSize: 11 }} onClick={() => rmSe(ci, si)}>✕</button>}</div>
              <textarea style={{ ...S.ta, minHeight: 80, fontSize: 13 }} value={sec.content} onChange={e => uSeC(ci, si, e.target.value)} placeholder="内容をペースト" />
              <button style={{ ...S.bsm(), marginTop: 6, fontSize: 11 }} onClick={() => { setATgt({ ci, si }); fRef.current?.click(); }}>📎 ファイル読込</button>
            </div>)}
            <button style={{ ...S.bsm(), width: "100%", marginTop: 4 }} onClick={() => addSec(ci)}>＋ 節を追加</button>
          </div>)}
          <button style={{ ...S.bsm(), width: "100%", marginBottom: 16 }} onClick={addCh}>＋ 章を追加</button>
          <input ref={fRef} type="file" accept="image/*,.pdf,application/pdf" style={{ display: "none" }} onChange={handleManualFile} />
          <button style={{ ...S.btn(true), width: "100%", opacity: hasC ? 1 : .4 }} disabled={!hasC} onClick={handleManualRegister}>キーワード抽出して登録</button>
        </div>
      )}
    </div>); }

  // ═══════ SOURCE ═══════
  if (view === "source" && selSec) { return (
    <div style={S.app}>
      <div style={S.hdr}><button style={S.bk} onClick={() => setView("sections")}>←</button><div><div style={{ fontSize: 18, fontWeight: 700 }}>📖 原文</div><div style={{ fontSize: 12, color: "#64748b" }}>{selSec.title}</div></div></div>
      <div style={{ background: "#131729", borderRadius: 14, padding: 20, border: "1px solid #1e293b", fontSize: 14, lineHeight: 1.9, color: "#cbd5e1", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {selSec.content || "（テキストなし）"}
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        {!selSec.referenceOnly && <>
          <button style={{ ...S.btn(true), flex: 1 }} onClick={() => startRecall(selMat, selChap, selSec)}>📝 説明モードへ</button>
          <button style={{ ...S.btn(), flex: 1, background: "#312e81", color: "#c4b5fd" }} onClick={() => startCloze(selMat, selChap, selSec)}>🧩 精密モードへ</button>
        </>}
      </div>
    </div>); }

  // ═══════ ADD CHAPTER ═══════
  if (view === "add-chapter" && selMat) { const mat = materials.find(m => m.id === selMat.id) || selMat; return (
    <div style={S.app}>{OV}
      <div style={S.hdr}><button style={S.bk} onClick={() => setView("chapters")}>←</button><div><div style={{ fontSize: 18, fontWeight: 700 }}>章を追加</div><div style={{ fontSize: 12, color: "#64748b" }}>{mat.title}</div></div></div>
      <div style={{ border: "2px dashed #334155", borderRadius: 14, padding: 24, textAlign: "center", cursor: "pointer", color: "#64748b", fontSize: 14, background: "#0f1225", marginBottom: 12 }} onClick={() => addChRef.current?.click()}>
        <div style={{ fontSize: 28, marginBottom: 6 }}>📄</div>章のファイルをアップロード<br /><span style={{ fontSize: 11, color: "#475569" }}>PDF / 画像 / スクショ（〜100ページ推奨）</span>
      </div>
      <input ref={addChRef} type="file" accept="image/*,.pdf,application/pdf" style={{ display: "none" }} onChange={handleAddChapterFile} />
      {addChPreview && <>
        <div style={{ marginBottom: 12 }}>
          <label style={S.lbl}>検出された構造</label>
          {addChPreview.chapters.map((ch, ci) => <div key={ci} style={{ ...S.card, marginBottom: 8 }}>
            <input style={{ ...S.inp, fontWeight: 700, marginBottom: 8 }} value={ch.title} onChange={e => { const n = JSON.parse(JSON.stringify(addChPreview)); n.chapters[ci].title = e.target.value; setACP(n); }} />
            {ch.sections.map((sec, si) => <div key={si} style={{ background: "#0f1225", borderRadius: 8, padding: 10, marginBottom: 6, border: "1px solid #1e293b" }}>
              <input style={{ ...S.inp, fontSize: 13, marginBottom: 6 }} value={sec.title} onChange={e => { const n = JSON.parse(JSON.stringify(addChPreview)); n.chapters[ci].sections[si].title = e.target.value; setACP(n); }} />
              <div style={{ fontSize: 12, color: "#64748b", maxHeight: 60, overflow: "hidden" }}>{sec.content?.slice(0, 150)}...</div>
            </div>)}
          </div>)}
        </div>
        <button style={{ ...S.btn(true), width: "100%", marginBottom: 8 }} onClick={handleAddChapterRegister}>キーワード抽出して追加</button>
        <button style={{ ...S.btn(), width: "100%" }} onClick={() => addChRef.current?.click()}>別のファイルで上書き</button>
      </>}
    </div>); }

  // ═══════ RECALL ═══════
  if (view === "recall" && selSec) { const lv = selSec.srs?.level || 0; return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => setView("sections")}>←</button><div><div style={{ fontSize: 18, fontWeight: 700 }}>説明モード</div><div style={{ fontSize: 12, color: "#64748b" }}>{selSec.title}</div></div></div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>{LVL.map((l, i) => <div key={i} style={{ padding: "6px 10px", fontSize: 10, fontWeight: 700, borderBottom: `2px solid ${i === lv ? LVLC[i] : "transparent"}`, color: i === lv ? LVLC[i] : "#475569" }}>{l}</div>)}</div>
      <div style={{ background: "linear-gradient(135deg,#1e1b4b,#131729)", borderRadius: 16, padding: 20, marginBottom: 16, border: "1px solid #312e81", textAlign: "center" }}>
        <div style={{ fontSize: 12, color: "#818cf8", fontWeight: 700, marginBottom: 12, letterSpacing: 2 }}>{lv === 3 ? "完全自力モード" : "KEYWORDS"}</div>
        {shownKws.length > 0 ? <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>{shownKws.map((kw, i) => <span key={i} style={{ padding: "8px 18px", borderRadius: 24, fontSize: 15, fontWeight: 700, background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44" }}>{kw}</span>)}</div> :
          <div style={{ fontSize: 14, color: "#818cf8" }}>記憶だけで説明してください</div>}
        {lv > 0 && lv < 3 && <div style={{ fontSize: 11, color: "#64748b", marginTop: 8 }}>全{selSec.keywords.length}個中 {shownKws.length}個</div>}
      </div>
      <div style={{ background: "#0f1225", borderRadius: 12, padding: 12, marginBottom: 16, border: "1px solid #1e293b", fontSize: 13, color: "#f87171", textAlign: "center" }}>⚠️ 教材は見ずに説明してください</div>
      <div style={{ marginBottom: 16 }}><label style={S.lbl}>あなたの説明</label><textarea style={{ ...S.ta, minHeight: 200 }} value={userAns} onChange={e => setUA(e.target.value)} placeholder="自分の言葉で説明..." /></div>
      <button style={{ ...S.btn(true), width: "100%", opacity: userAns.trim() ? 1 : .4 }} disabled={!userAns.trim()} onClick={submitRecall}>AIに評価してもらう</button>
    </div>); }

  // ═══════ CLOZE ═══════
  if (view === "cloze" && clozeQs.length > 0) return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => setView("sections")}>←</button><div><div style={{ fontSize: 18, fontWeight: 700 }}>🧩 精密モード</div><div style={{ fontSize: 12, color: "#64748b" }}>{selSec?.title}</div></div></div>
      <div style={{ background: "#0f1225", borderRadius: 12, padding: 12, marginBottom: 16, border: "1px solid #312e81", fontSize: 13, color: "#a78bfa", textAlign: "center" }}>用語・数値・定義を正確に答えてください</div>
      {clozeQs.map((q, i) => <div key={i} style={S.card}>
        <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 8 }}><span style={{ color: "#64748b", fontSize: 12, marginRight: 6 }}>Q{i + 1}</span>{q.question}</div>
        {q.hint && <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>💡 {q.hint}</div>}
        <input style={S.inp} value={clozeAs[i] || ""} onChange={e => setCA(p => ({ ...p, [i]: e.target.value }))} placeholder="回答" />
      </div>)}
      <button style={{ ...S.btn(true), width: "100%" }} onClick={submitCloze}>答え合わせ</button>
    </div>
  );

  // ═══════ CLOZE RESULT ═══════
  if (view === "cloze-result" && clozeResult) { const cr = clozeResult; const nd = cr.srs ? Math.ceil((cr.srs.nextReview - Date.now()) / 864e5) : null; return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => setView("sections")}>←</button><div style={{ fontSize: 18, fontWeight: 700 }}>精密モード 結果</div></div>
      <div style={{ textAlign: "center", marginBottom: 20 }}><SB score={cr.score} size={96} /><div style={{ fontSize: 13, color: "#94a3b8", marginTop: 8 }}>{cr.results.filter(r => r.correct).length}/{cr.results.length} 正解</div></div>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-around", textAlign: "center", marginBottom: 16 }}><div><div style={{ fontSize: 11, color: "#64748b" }}>次回</div><div style={{ fontWeight: 700, fontSize: 16 }}>{nd !== null ? `${Math.max(0, nd)}日後` : "—"}</div></div><div><div style={{ fontSize: 11, color: "#64748b" }}>間隔</div><div style={{ fontWeight: 700, fontSize: 16 }}>{cr.srs?.interval || 1}日</div></div></div>
      {cr.results.map((r, i) => <div key={i} style={{ ...S.fb(r.correct ? "#34d399" : "#f87171") }}>
        <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 4 }}>{r.question}</div>
        <div style={{ fontSize: 13 }}>あなた: <span style={{ fontWeight: 700, color: r.correct ? "#34d399" : "#f87171" }}>{r.userAnswer || "(未回答)"}</span>{!r.correct && <span> → 正解: <span style={{ fontWeight: 700, color: "#34d399" }}>{r.answer}</span></span>}</div>
      </div>)}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}><button style={{ ...S.btn(true), flex: 1 }} onClick={() => startCloze(selMat, selChap, selSec)}>再挑戦</button><button style={{ ...S.btn(), flex: 1 }} onClick={() => setView("sections")}>戻る</button></div>
    </div>); }

  // ═══════ RESULT (explain) ═══════
  if (view === "result" && lastResult) { const r = lastResult; const nd = r.srs ? Math.ceil((r.srs.nextReview - Date.now()) / 864e5) : null; return (
    <div style={S.app}>{OV}<div style={S.hdr}><button style={S.bk} onClick={() => setView("sections")}>←</button><div style={{ fontSize: 18, fontWeight: 700 }}>評価結果</div></div>
      <div style={{ textAlign: "center", marginBottom: 20 }}><SB score={r.score} size={96} /><div style={{ fontSize: 13, color: "#94a3b8", marginTop: 8 }}>{r.score >= 80 ? "素晴らしい！" : r.score >= 50 ? "もう少し深掘り" : "再挑戦しよう"}</div></div>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-around", textAlign: "center", marginBottom: 16 }}>
        <div><div style={{ fontSize: 11, color: "#64748b" }}>難易度</div><LB level={r.srs?.level ?? r.level} /><div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{r.score >= 80 ? "↑ UP" : r.score < 50 ? "↓ DOWN" : "→"}</div></div>
        <div><div style={{ fontSize: 11, color: "#64748b" }}>次回</div><div style={{ fontWeight: 700, fontSize: 16 }}>{nd !== null ? `${Math.max(0, nd)}日後` : "—"}</div></div>
        <div><div style={{ fontSize: 11, color: "#64748b" }}>間隔</div><div style={{ fontWeight: 700, fontSize: 16 }}>{r.srs?.interval || 1}日</div></div>
      </div>
      <div style={S.fb("#34d399")}><div style={{ fontSize: 12, fontWeight: 700, color: "#34d399", marginBottom: 6 }}>✓ 正しい理解</div><div style={{ fontSize: 14, lineHeight: 1.7 }}>{r.correct_understanding}</div></div>
      <div style={S.fb("#fbbf24")}><div style={{ fontSize: 12, fontWeight: 700, color: "#fbbf24", marginBottom: 6 }}>△ 不足点</div><div style={{ fontSize: 14, lineHeight: 1.7 }}>{r.missing_points}</div></div>
      <div style={S.fb("#f87171")}><div style={{ fontSize: 12, fontWeight: 700, color: "#f87171", marginBottom: 6 }}>✗ 誤解</div><div style={{ fontSize: 14, lineHeight: 1.7 }}>{r.misconceptions}</div></div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button style={{ ...S.btn(true), flex: 1 }} onClick={() => { const m = materials.find(x => x.id === r.materialId); if (!m) return; const c = m.chapters.find(x => x.sections.some(s => s.id === r.sectionId)); const s = c?.sections.find(x => x.id === r.sectionId); if (c && s) startRecall(m, c, s); }}>再挑戦</button>
        <button style={{ ...S.btn(), flex: 1 }} onClick={() => setView("sections")}>戻る</button>
      </div>
    </div>); }

  // ═══════ DUE ═══════
  if (view === "due") { const due = getDue(); return (
    <div style={S.app}>{OV}<div style={S.hdr}><div style={{ fontSize: 18, fontWeight: 700 }}>🔔 要復習</div></div>
      {due.length === 0 ? <div style={S.emp}><div style={{ fontSize: 32, marginBottom: 12 }}>✨</div>今日の復習は完了！</div> :
        due.map(({ mat, chap, sec }) => <div key={sec.id} style={S.card}>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>{mat.title} › {chap.title}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><span style={{ fontWeight: 700 }}>{sec.title}</span><LB level={sec.srs?.level || 0} /></div>
          <div style={{ display: "flex", gap: 8 }}><button style={S.btn(true)} onClick={() => startRecall(mat, chap, sec)}>📝 説明</button><button style={{ ...S.btn(), background: "#312e81", color: "#c4b5fd" }} onClick={() => startCloze(mat, chap, sec)}>🧩 精密</button></div>
        </div>)}
      {NV("due")}
    </div>); }

  // ═══════ REVIEW ═══════
  if (view === "review") { const sorted = [...attempts].sort((a, b) => a.score - b.score); return (
    <div style={S.app}>{OV}<div style={S.hdr}><div style={{ fontSize: 18, fontWeight: 700 }}>📊 履歴</div></div>
      {sorted.length === 0 ? <div style={S.emp}><div style={{ fontSize: 32, marginBottom: 12 }}>🧠</div>まだ記録がありません</div> :
        sorted.map(a => <div key={a.id} style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{a.sectionTitle || a.materialTitle}</div><div style={{ fontSize: 11, color: "#64748b" }}>{a.materialTitle} {a.chapterTitle && `› ${a.chapterTitle}`}</div></div>
            <SB score={a.score} size={40} />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12, background: a.mode === "cloze" ? "#312e81" : "#1e293b", color: a.mode === "cloze" ? "#c4b5fd" : "#94a3b8" }}>{a.mode === "cloze" ? "🧩 精密" : "📝 説明"}</span>
            <span style={{ fontSize: 11, color: "#64748b" }}>{new Date(a.createdAt).toLocaleDateString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={S.btn(true)} onClick={() => { const m = materials.find(x => x.id === a.materialId); if (!m) { alert("教材削除済み"); return; } const c = m.chapters.find(x => x.sections.some(s => s.id === a.sectionId)); const s = c?.sections.find(x => x.id === a.sectionId); if (c && s) { if (a.mode === "cloze") startCloze(m, c, s); else startRecall(m, c, s); } }}>再挑戦</button>
            {a.mode === "explain" && <button style={S.bsm()} onClick={() => { setLR(a); setView("result"); }}>詳細</button>}
            {a.mode === "cloze" && a.clozeResults && <button style={S.bsm()} onClick={() => { setCR({ score: a.score, results: a.clozeResults, srs: a.srs }); setView("cloze-result"); }}>詳細</button>}
          </div>
        </div>)}
      {NV("review")}
    </div>); }

  return <div style={S.app}><div style={S.emp}>表示エラー</div></div>;
}
