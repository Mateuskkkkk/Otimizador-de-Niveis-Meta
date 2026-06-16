import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceArea
} from "recharts";
import { toBlob } from "html-to-image";
import JSZip from "jszip";
import { saveAs } from "file-saver";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO DA API
// ─────────────────────────────────────────────────────────────────────────────
// Altera esta variável quando publicares o backend no Render
const API_BASE_URL = "http://localhost:8000/api";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES & CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
interface Scenario {
  id: string; name: string; durb: number; dsupl: number;
  fracDurb: number[]; fracDsup: number[]; garantiaReq: number[];
}

interface SimResult {
  status: "sucesso" | "erro" | "limites" | "reservatorios" | "progresso";
  cenario_id?: string;
  lista?: string[];
  niveis_meta?: number[];
  garantias_obtidas?: number[];
  matriz_curvas?: number[][];
  volumes_historicos?: number[];
  capacidade_hm3?: number;
  mes_inicio?: number;
  ano_inicio?: number;
  iteracao?: number;
  total_iteracoes?: number;
  mensagem?: string;
  ano_min?: number; mes_min?: number;
  ano_max?: number; mes_max?: number;
}

interface ToastMsg { id: number; type: "error" | "success" | "info"; text: string; }

const MESES_NOMES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const MESES_CURTOS = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
const NIVEL_LABELS = ["Normal", "Alerta", "Seca", "Seca Severa"];
const CURVE_COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444"]; 

function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [reservatorio, setReservatorio] = useState("");
  const [listaReservatorios, setListaReservatorios] = useState<string[]>([]);
  const [prob, setProb] = useState(0.25);
  const [iters, setIters] = useState(50);
  const [ninicio, setNinicio] = useState(7);
  const [mesIni, setMesIni] = useState(1);
  const [anoIni, setAnoIni] = useState(1911);
  const [mesFim, setMesFim] = useState(12);
  const [anoFim, setAnoFim] = useState(2021);
  const [bounds, setBounds] = useState({ anoMin: 1911, mesMin: 1, anoMax: 2021, mesMax: 12 });

  const defaultScenario = (): Scenario => ({
    id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
    name: "Cenário 1", durb: 0.5, dsupl: 0.3,
    fracDurb: [1.0, 1.0, 0.8, 0.5], fracDsup: [1.0, 0.8, 0.5, 0.0], garantiaReq: [.90, 0.95, 0.98, 1]
  });

  const [scenarios, setScenarios] = useState<Scenario[]>([defaultScenario()]);
  const [activeScenId, setActiveScenId] = useState<string>(scenarios[0].id);
  const activeScenario = scenarios.find(s => s.id === activeScenId) || scenarios[0];

  const [loading, setLoading] = useState(false);
  const [progressoSimulacao, setProgressoSimulacao] = useState(0); 
  const [isExporting, setIsExporting] = useState(false);
  const [results, setResults] = useState<Record<string, SimResult>>({});
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  
  const [zoomDomain, setZoomDomain] = useState<{ start: number, end: number } | null>(null);
  const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<string | null>(null);

  const exportRef = useRef<HTMLDivElement>(null);
  const toastIdRef = useRef(0);
  const tabsRef = useRef<HTMLDivElement>(null);

  const isDark = theme === "dark";
  const themeBg = isDark ? "bg-slate-950 text-slate-200" : "bg-slate-200 text-slate-800";
  const panelBg = isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-300";
  const inputBg = isDark ? "bg-slate-950 border-slate-900 text-white" : "bg-slate-200 border-slate-300 text-slate-900";
  const exportBg = isDark ? "bg-slate-950 border-slate-800" : "bg-white border-slate-300";
  const textMuted = isDark ? "text-slate-300" : "text-slate-700";
  const borderColor = isDark ? "border-slate-700" : "border-slate-300";

  const addToast = useCallback((type: ToastMsg["type"], text: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((p) => p.filter((t) => t.id !== id)), []);

  const updateActiveScenario = (updates: Partial<Scenario>) => {
    setScenarios(prev => prev.map(s => s.id === activeScenId ? { ...s, ...updates } : s));
  };

  const addScenario = () => {
    if (scenarios.length >= 10) return addToast("error", "Máximo de 10 cenários atingido.");
    const newScen = { ...defaultScenario(), name: `Cenário ${scenarios.length + 1}` };
    setScenarios([...scenarios, newScen]);
    setActiveScenId(newScen.id);
  };

  const removeScenario = (id: string) => {
    if (scenarios.length === 1) return;
    const newScens = scenarios.filter(s => s.id !== id);
    setScenarios(newScens);
    if (activeScenId === id) setActiveScenId(newScens[0].id);
    setResults(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  // BUSCAR RESERVATÓRIOS (Substitui o primeiro comando Tauri)
  useEffect(() => {
    fetch(`${API_BASE_URL}/reservatorios`)
      .then(res => res.json())
      .then(data => {
        if (data.status === "reservatorios" && data.lista) {
          setListaReservatorios(data.lista);
          setReservatorio(prev => prev || data.lista[0]);
        }
      })
      .catch(() => addToast("error", "Erro ao conectar com o servidor API."));
  }, [addToast]);

  // BUSCAR LIMITES AO MUDAR RESERVATÓRIO (Substitui o segundo comando Tauri)
  useEffect(() => {
    if (!reservatorio) return;
    fetch(`${API_BASE_URL}/limites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservatorio })
    })
      .then(res => res.json())
      .then(data => {
        if (data.status === "limites") {
          setBounds({
            anoMin: data.ano_min ?? 1911, mesMin: data.mes_min ?? 1,
            anoMax: data.ano_max ?? 2021, mesMax: data.mes_max ?? 12
          });
          setAnoIni(p => Math.max(data.ano_min ?? 1911, Math.min(p, data.ano_max ?? 2021)));
          setAnoFim(p => Math.max(data.ano_min ?? 1911, Math.min(p, data.ano_max ?? 2021)));
        }
      })
      .catch(() => addToast("error", "Erro ao buscar limites do reservatório."));
  }, [reservatorio, addToast]);

  // OTIMIZAÇÃO (SSE) - O "Coração" que comunica com o FastAPI
  const handleSimularTodos = async () => {
    if (!reservatorio) return addToast("error", "Selecione um reservatório.");
    setLoading(true);
    setProgressoSimulacao(0);
    setResults({});
    setZoomDomain(null);

    try {
      for (const scen of scenarios) {
        const payload = {
          cenario_id: scen.id, reservatorio, prob, iters, ninicio,
          mes_inicio: mesIni, ano_inicio: anoIni, mes_fim: mesFim, ano_fim: anoFim,
          durb_m3s: scen.durb, dsupl_m3s: scen.dsupl,
          frac_durb: scen.fracDurb, frac_dsup: scen.fracDsup, garantia_req: scen.garantiaReq,
        };

        const response = await fetch(`${API_BASE_URL}/simular`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.body) throw new Error("Sem resposta do servidor.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed: SimResult = JSON.parse(line.substring(6));
                
                if (parsed.status === "progresso") {
                  if (parsed.iteracao && parsed.total_iteracoes) {
                    const perc = Math.round((parsed.iteracao / parsed.total_iteracoes) * 100);
                    setProgressoSimulacao(perc);
                  }
                } else if (parsed.status === "sucesso") {
                  setProgressoSimulacao(100);
                  setResults(prev => ({ ...prev, [parsed.cenario_id!]: parsed }));
                } else if (parsed.status === "erro") {
                  addToast("error", `Erro: ${parsed.mensagem}`);
                }
              } catch (e) {
                console.error("Erro ao analisar bloco SSE", e);
              }
            }
          }
        }
      }
    } catch (err) {
      addToast("error", `Falha ao iniciar: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const exportImage = async () => { /* ... código mantido ... */
    if (!exportRef.current) return;
    try {
      await new Promise(r => setTimeout(r, 100));
      const blob = await toBlob(exportRef.current, { backgroundColor: isDark ? "#020617" : "#ffffff", pixelRatio: 2, style: { overflow: 'hidden' } });
      if (!blob) throw new Error("A imagem gerada está vazia.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `simulacao_${reservatorio}_${activeScenario.name.replace(/ /g,"_")}.png`;
      link.href = url; document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
    } catch (err: any) { addToast("error", `Erro na captura: ${err.message || "Desconhecido"}`); }
  };

  const exportAllAsZip = async () => { /* ... código mantido ... */
    if (Object.keys(results).length === 0) return addToast("error", "Simule os cenários primeiro antes de exportar.");
    setIsExporting(true);
    const zip = new JSZip();
    const folder = zip.folder(`Cenarios_${reservatorio}`);
    const originalTab = activeScenId;
    try {
      for (const scen of scenarios) {
        if (!results[scen.id]) continue;
        setActiveScenId(scen.id);
        await new Promise(r => setTimeout(r, 600)); 
        if (exportRef.current) {
          const blob = await toBlob(exportRef.current, { backgroundColor: isDark ? "#020617" : "#ffffff", pixelRatio: 2, style: { overflow: 'hidden' } });
          if (blob) folder?.file(`${scen.name.replace(/ /g, "_")}.png`, blob);
        }
      }
      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `Simulacoes_${reservatorio}.zip`);
      addToast("success", "Todos os cenários exportados com sucesso!");
    } catch (err: any) { addToast("error", `Erro ao empacotar ZIP: ${err.message || "Desconhecido"}`);
    } finally { setActiveScenId(originalTab); setIsExporting(false); }
  };

  const exportCSV = () => { /* ... código mantido ... */
    const res = results[activeScenId];
    if (!res || !res.matriz_curvas) return;
    let csv = "Mes;" + NIVEL_LABELS.slice(0, 3).join(";") + "\n";
    MESES_CURTOS.forEach((m, i) => { csv += `${m};${res.matriz_curvas![0][i]};${res.matriz_curvas![1][i]};${res.matriz_curvas![2][i]}\n`; });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `curvas_${reservatorio}_${activeScenario.name}.csv`; link.click();
  };

  const exportVolumeCSV = () => { /* ... código mantido ... */
    const res = results[activeScenId];
    if (!res || !res.volumes_historicos) return;
    let csv = "Data;Volume Absoluto (hm3);Volume Percentual (%)\n";
    const simMesIni = res.mes_inicio ?? mesIni;
    const simAnoIni = res.ano_inicio ?? anoIni;
    const cap = res.capacidade_hm3 || 1;
    res.volumes_historicos.forEach((vol, index) => {
      const mesDoAno = (simMesIni - 1 + index) % 12;
      const anoAtual = simAnoIni + Math.floor((simMesIni - 1 + index) / 12);
      const dataStr = `${MESES_CURTOS[mesDoAno]}/${anoAtual}`;
      const volPerc = (vol / cap) * 100;
      csv += `${dataStr};${vol.toFixed(2)};${volPerc.toFixed(2)}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); 
    link.href = url; link.download = `volumes_${reservatorio}_${activeScenario.name.replace(/ /g,"_")}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  const currentResult = results[activeScenId];
  const chartData = currentResult?.matriz_curvas ? MESES_CURTOS.map((mes, mi) => {
    const point: any = { mes, max: 100 };
    currentResult.matriz_curvas!.forEach((curve, ci) => { point[`nivel_${ci}`] = parseFloat((curve[mi] * 100).toFixed(2)); });
    return point;
  }) : [];

  const chartDataVolume = (currentResult?.volumes_historicos && currentResult.volumes_historicos.length > 0)
    ? currentResult.volumes_historicos.map((vol, index) => {
        const simMesIni = currentResult.mes_inicio ?? mesIni;
        const simAnoIni = currentResult.ano_inicio ?? anoIni;
        const mesDoAno = (simMesIni - 1 + index) % 12; 
        const anoAtual = simAnoIni + Math.floor((simMesIni - 1 + index) / 12);
        const cap = currentResult.capacidade_hm3 || 1; 
        const volPerc = (vol / cap) * 100;
        const n0 = currentResult.matriz_curvas ? currentResult.matriz_curvas[0][mesDoAno] * 100 : 0;
        const n1 = currentResult.matriz_curvas ? currentResult.matriz_curvas[1][mesDoAno] * 100 : 0;
        const n2 = currentResult.matriz_curvas ? currentResult.matriz_curvas[2][mesDoAno] * 100 : 0;
        let estado = 0; 
        if (volPerc < n2) estado = 3; else if (volPerc < n1) estado = 2; else if (volPerc < n0) estado = 1;
        return { 
          data: `${MESES_CURTOS[mesDoAno]}/${anoAtual}`, origVol: Number(volPerc.toFixed(2)), origEstado: estado,
          vol_0: null, vol_1: null, vol_2: null, vol_3: null
        };
      })
    : [];

  for (let i = 0; i < chartDataVolume.length; i++) {
    const curr = chartDataVolume[i] as any; curr[`vol_${curr.origEstado}`] = curr.origVol;
    if (i > 0) {
      const prev = chartDataVolume[i - 1] as any;
      if (prev.origEstado !== curr.origEstado) curr[`vol_${prev.origEstado}`] = curr.origVol;
    }
  }

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const pointData = payload[0].payload;
      const color = CURVE_COLORS[pointData.origEstado];
      const statusLabel = NIVEL_LABELS[pointData.origEstado];
      return (
        <div className={`p-3 rounded-lg border shadow-lg text-xs ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}>
          <p className="font-bold mb-2 border-b pb-1 opacity-80">{label}</p>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }}></span>
            <span className="font-mono text-sm">Volume: <strong>{pointData.origVol}%</strong></span>
          </div>
          <p className="text-[10px] font-mono opacity-60 uppercase tracking-wider mt-2">
            Estado: <span style={{ color, fontWeight: 'bold' }}>{statusLabel}</span>
          </p>
        </div>
      );
    }
    return null;
  };

  const activeDataVolume = zoomDomain ? chartDataVolume.slice(zoomDomain.start, zoomDomain.end + 1) : chartDataVolume;
  const handleZoom = () => {
    if (refAreaLeft === refAreaRight || !refAreaLeft || !refAreaRight) { setRefAreaLeft(null); setRefAreaRight(null); return; }
    let startIndex = chartDataVolume.findIndex((d: any) => d.data === refAreaLeft);
    let endIndex = chartDataVolume.findIndex((d: any) => d.data === refAreaRight);
    if (startIndex > endIndex) [startIndex, endIndex] = [endIndex, startIndex];
    setZoomDomain({ start: startIndex, end: endIndex }); setRefAreaLeft(null); setRefAreaRight(null);
  };

  return (
    <div className={`h-screen w-full flex font-sans overflow-hidden relative ${themeBg}`}>
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 min-w-[280px]">
        {toasts.map((t) => (
          <div key={t.id} className={`flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-mono border ${t.type === "error" ? "bg-red-950 border-red-700 text-red-200" : "bg-emerald-950 border-emerald-700 text-emerald-200"}`}>
            <span className="flex-1">{t.text}</span><button onClick={() => dismissToast(t.id)}>×</button>
          </div>
        ))}
      </div>

      <aside className={`w-[340px] flex-shrink-0 border-r flex flex-col z-30 shadow-lg ${panelBg}`}>
        <div className={`p-4 border-b flex flex-col gap-4 ${isDark ? "border-slate-800" : "border-slate-300"}`}>
          <div>
            <label className={`block text-[10px] text-center font-mono uppercase mb-1 ${textMuted}`}>Reservatório</label>
            <select value={reservatorio} onChange={(e) => setReservatorio(e.target.value)} className={`w-4/5 mx-auto block rounded p-2 text-sm text-left border font-mono ${inputBg}`}>
              {listaReservatorios.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <label className={`block text-[10px] font-mono uppercase mb-1 ${textMuted}`}>Prob. Afluência</label>
              <div className="flex items-center gap-3">
                <input type="range" min={0.05} max={0.95} step={0.05} value={prob} onChange={(e) => setProb(parseFloat(e.target.value))} className="flex-1 accent-sky-500" />
                <input type="number" step={0.05} value={prob} onChange={(e) => setProb(parseFloat(e.target.value))} className={`w-16 rounded p-1.5 text-xs text-center border font-mono ${inputBg}`} />
              </div>
            </div>
            <div>
              <label className={`block text-[10px] font-mono uppercase mb-1 ${textMuted}`}>Iterações PSO</label>
              <div className="flex items-center gap-3">
                <input type="range" min={10} max={500} step={10} value={iters} onChange={(e) => setIters(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
                <input type="number" value={iters} onChange={(e) => setIters(parseInt(e.target.value))} className={`w-16 rounded p-1.5 text-xs text-center border font-mono ${inputBg}`} />
              </div>
            </div>
          </div>
          <div>
            <div className="flex justify-between items-end mb-2"><label className={`text-[10px] font-mono uppercase ${textMuted}`}>Período de Simulação</label></div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-center items-center gap-3">
                <span className={`w-10 text-[9px] text-left font-mono uppercase ${textMuted}`}>Início</span>
                <div className="flex gap-1">
                  <select value={mesIni} onChange={(e) => setMesIni(parseInt(e.target.value))} className={`w-20 rounded p-1.5 text-xs text-left border font-mono ${inputBg}`}>{MESES_CURTOS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}</select>
                  <input type="number" min={bounds.anoMin} max={anoFim} value={anoIni} onChange={(e) => setAnoIni(parseInt(e.target.value))} className={`w-20 rounded p-1.5 text-xs border text-center font-mono ${inputBg}`} />
                </div>
              </div>
              <div className="flex justify-center items-center gap-3">
                <span className={`w-10 text-[9px] text-left font-mono uppercase ${textMuted}`}>Fim</span>
                <div className="flex gap-1">
                  <select value={mesFim} onChange={(e) => setMesFim(parseInt(e.target.value))} className={`w-20 rounded p-1.5 text-xs text-left border font-mono ${inputBg}`}>{MESES_CURTOS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}</select>
                  <input type="number" min={anoIni} max={bounds.anoMax} value={anoFim} onChange={(e) => setAnoFim(parseInt(e.target.value))} className={`w-20 rounded p-1.5 text-xs border text-center font-mono ${inputBg}`} />
                </div>
              </div>
            </div>
          </div>
          <div>
             <label className={`block text-[10px] text-center font-mono uppercase mb-1 ${textMuted}`}>Mês Início Ano Hidrológico</label>
             <select value={ninicio} onChange={(e) => setNinicio(parseInt(e.target.value))} className={`w-25 mx-auto block rounded p-1.5 text-xs text-left border font-mono ${inputBg}`}>{MESES_NOMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}</select>
          </div>
        </div>

        <div ref={tabsRef} className={`flex overflow-x-auto border-b no-scrollbar scroll-smooth ${isDark ? "bg-slate-900 border-slate-800" : "bg-slate-100 border-slate-300"}`}>
          {scenarios.map(s => (
            <button key={s.id} onClick={() => setActiveScenId(s.id)} className={`px-4 py-2 text-xs font-mono whitespace-nowrap border-r ${isDark ? "border-slate-800" : "border-slate-300"} ${activeScenId === s.id ? (isDark ? "bg-slate-800 text-sky-400" : "bg-white text-sky-600 font-bold") : `${textMuted} hover:bg-slate-500/20`}`}>
              {s.name}{scenarios.length > 1 && <span onClick={(e) => { e.stopPropagation(); removeScenario(s.id); }} className="ml-2 text-red-400 hover:text-red-500">×</span>}
            </button>
          ))}
          <button onClick={addScenario} className="px-4 py-2 text-xs font-mono text-sky-500">+</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">
          <div className="flex justify-center gap-8 px-2">
            <div className="w-32"><label className={`block text-[10px] text-center font-mono uppercase mb-1 ${textMuted}`}>Demanda Urbana (m³/s)</label><input type="number" step={0.01} value={activeScenario.durb} onChange={(e) => updateActiveScenario({ durb: parseFloat(e.target.value) })} className={`w-full rounded p-1.5 text-sm text-center border font-mono ${inputBg}`} /></div>
            <div className="w-32"><label className={`block text-[10px] text-center font-mono uppercase mb-1 ${textMuted}`}>Usos Múltiplos (m³/s)</label><input type="number" step={0.01} value={activeScenario.dsupl} onChange={(e) => updateActiveScenario({ dsupl: parseFloat(e.target.value) })} className={`w-full rounded p-1.5 text-sm text-center border font-mono ${inputBg}`} /></div>
          </div>
          <div className="flex flex-col gap-2">
            <div>
              <p className={`text-[10px] text-center font-mono uppercase mb-2 ${textMuted}`}>Garantias Requeridas (%)</p>
              <div className="flex mb-1">{NIVEL_LABELS.map((lbl, i) => (<div key={i} className="w-1/4 text-[9px] font-mono text-center truncate" style={{ color: CURVE_COLORS[i] }}>{lbl}</div>))}</div>
              <div className={`flex border rounded overflow-hidden ${borderColor}`}>
                {activeScenario.garantiaReq.map((v, i) => (<input key={i} type="number" step={1} min={0} max={100} value={Number((v * 100).toFixed(1))} onChange={(e) => { let val = parseFloat(e.target.value); if (isNaN(val)) val = 0; if (val > 100) val = 100; if (val < 0) val = 0; const n = [...activeScenario.garantiaReq]; n[i] = val / 100; updateActiveScenario({ garantiaReq: n }); }} className={`w-1/4 p-1.5 text-xs text-center font-mono outline-none border-r last:border-r-0 ${borderColor} ${inputBg}`} />))}
              </div>
            </div>
            <div>
              <p className={`text-[10px] text-center font-mono uppercase mb-2 ${textMuted}`}>Atendimento da Demanda Urbana (%)</p>
              <div className={`flex border rounded overflow-hidden ${borderColor}`}>
                {activeScenario.fracDurb.map((v, i) => (<input key={i} type="number" step={1} min={0} max={100} value={Number((v * 100).toFixed(1))} onChange={(e) => { let val = parseFloat(e.target.value); if (isNaN(val)) val = 0; if (val > 100) val = 100; if (val < 0) val = 0; const n = [...activeScenario.fracDurb]; n[i] = val / 100; updateActiveScenario({ fracDurb: n }); }} className={`w-1/4 p-1.5 text-xs text-center font-mono outline-none border-r last:border-r-0 ${borderColor} ${inputBg}`} />))}
              </div>
            </div>
            <div>
              <p className={`text-[10px] text-center font-mono uppercase mb-2 ${textMuted}`}>Atendimento de Usos Múltiplos (%)</p>
              <div className={`flex border rounded overflow-hidden ${borderColor}`}>
                {activeScenario.fracDsup.map((v, i) => (<input key={i} type="number" step={1} min={0} max={100} value={Number((v * 100).toFixed(1))} onChange={(e) => { let val = parseFloat(e.target.value); if (isNaN(val)) val = 0; if (val > 100) val = 100; if (val < 0) val = 0; const n = [...activeScenario.fracDsup]; n[i] = val / 100; updateActiveScenario({ fracDsup: n }); }} className={`w-1/4 p-1.5 text-xs text-center font-mono outline-none border-r last:border-r-0 ${borderColor} ${inputBg}`} />))}
              </div>
            </div>
          </div>
          <button onClick={handleSimularTodos} disabled={loading || !reservatorio} className="mt-auto w-full py-3 rounded bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-xs uppercase tracking-widest transition disabled:opacity-50 shadow-md">
            {loading ? "Simulando..." : "Simular Cenários"}
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden relative">
        <main className={`flex-1 overflow-y-auto p-6 ${themeBg}`}>
          <div className="flex justify-between items-center mb-6 max-w-5xl mx-auto w-full">
            <div className="flex gap-2 items-center">
              {currentResult && !loading && (
                <>
                  <button disabled={isExporting} onClick={exportCSV} className={`px-3 py-1.5 rounded text-xs font-mono border transition disabled:opacity-50 ${isDark ? "bg-slate-800 hover:bg-slate-700 border-slate-700" : "bg-slate-200 hover:bg-slate-300 border-slate-300 text-black"}`}>⬇ CSV Curvas</button>
                  <button disabled={isExporting} onClick={exportVolumeCSV} className={`px-3 py-1.5 rounded text-xs font-mono border transition disabled:opacity-50 ${isDark ? "bg-slate-800 hover:bg-slate-700 border-slate-700" : "bg-slate-200 hover:bg-slate-300 border-slate-300 text-black"}`}>⬇ CSV Volumes</button>
                  <button disabled={isExporting} onClick={exportImage} className={`px-3 py-1.5 rounded text-xs font-mono border transition disabled:opacity-50 ${isDark ? "bg-slate-800 hover:bg-slate-700 border-slate-700" : "bg-slate-200 hover:bg-slate-300 border-slate-300 text-black"}`}>↓ Gráfico Atual</button>
                  <button disabled={isExporting} onClick={exportAllAsZip} className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs font-mono transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed">📦 Exportar Tudo (ZIP)</button>
                </>
              )}
            </div>
            <div className="flex gap-2 items-center">
              <button onClick={() => setTheme(isDark ? "light" : "dark")} className={`px-3 py-1.5 rounded text-xs font-mono border transition ${inputBg}`}>Modo {isDark ? "Claro ☀" : "Escuro 🌙"}</button>
            </div>
          </div>

          {!currentResult && !loading && (<div className={`h-full flex flex-col items-center justify-center ${textMuted}`}><span className="text-4xl mb-2 opacity-30">📊</span><p className="font-mono text-sm">Nenhum resultado para este cenário ainda.</p></div>)}

          {loading && (
            <div className="h-full flex flex-col items-center justify-center gap-5">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-sky-600 border-t-transparent"></div>
              <div className="w-80 bg-slate-300 dark:bg-slate-800 rounded-full h-4 overflow-hidden shadow-inner relative"><div className="bg-sky-500 h-full transition-all duration-300 ease-out" style={{ width: `${progressoSimulacao}%` }}></div></div>
              <p className="font-mono text-sm text-sky-600 dark:text-sky-400 font-bold tracking-widest uppercase">Otimizando Níveis Meta... {progressoSimulacao}%</p>
            </div>
          )}

          {currentResult && !loading && (
            <div className="flex flex-col gap-4 max-w-5xl mx-auto">
              <div ref={exportRef} className={`p-6 rounded-xl border flex flex-col gap-8 ${exportBg}`}>
                <div className="text-center">
                  <h2 className={`text-lg font-mono font-bold ${theme === "dark" ? "text-slate-100" : "text-slate-900"}`}>Reservatório {reservatorio}</h2>
                  <p className={`text-xs font-mono ${textMuted}`}>{activeScenario.name} | Demanda Total: {((activeScenario.durb + activeScenario.dsupl)*1000).toFixed(1)} L/s</p>
                </div>
                <div className="h-[350px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#e2e8f0"} />
                      <XAxis dataKey="mes" tick={{ fill: isDark ? "#64748b" : "#475569", fontSize: 10 }} axisLine={{ stroke: isDark ? "#334155" : "#cbd5e1" }} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fill: isDark ? "#64748b" : "#475569", fontSize: 10 }} axisLine={{ stroke: isDark ? "#334155" : "#cbd5e1" }} tickLine={false} tickFormatter={(v) => `${v}%`} />
                      <Tooltip contentStyle={{ backgroundColor: isDark ? "#0f172a" : "#ffffff", borderColor: isDark ? "#1e293b" : "#e2e8f0", color: isDark ? "#fff" : "#000", fontSize: "12px" }} />
                      <Legend content={() => (<div className="flex justify-center gap-5 pt-3 text-[11px]" style={{ color: isDark ? "#cbd5e1" : "#334155" }}>{NIVEL_LABELS.map((lbl, i) => (<div key={i} className="flex items-center gap-1.5"><span className="w-3 h-3 block rounded-sm" style={{ backgroundColor: CURVE_COLORS[i] }}></span><span>{lbl}</span></div>))}</div>)} />
                      <Area isAnimationActive={false} type="monotone" name="Normal" dataKey="max" stroke="none" fill={CURVE_COLORS[0]} fillOpacity={1} />
                      <Area isAnimationActive={false} type="monotone" name="Alerta" dataKey="nivel_0" stroke={CURVE_COLORS[1]} strokeWidth={3} fill={CURVE_COLORS[1]} fillOpacity={1} />
                      <Area isAnimationActive={false} type="monotone" name="Seca" dataKey="nivel_1" stroke={CURVE_COLORS[2]} strokeWidth={3} fill={CURVE_COLORS[2]} fillOpacity={1} />
                      <Area isAnimationActive={false} type="monotone" name="Seca Severa" dataKey="nivel_2" stroke={CURVE_COLORS[3]} strokeWidth={3} fill={CURVE_COLORS[3]} fillOpacity={1} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-col gap-6">
                  <div>
                    <h3 className={`text-xs font-mono uppercase mb-2 border-b pb-1 ${textMuted} ${isDark ? "border-slate-800" : "border-slate-200"}`}>Desempenho e Vazões</h3>
                    <table className="w-full text-xs font-mono text-center">
                      <thead className={textMuted}><tr><th className="py-2">Nível Operacional</th><th className="py-2">Vazão Total (L/s)</th><th className="py-2">Garantia Exigida</th><th className="py-2">Garantia Obtida</th></tr></thead>
                      <tbody>
                        {NIVEL_LABELS.map((lbl, i) => {
                          const vazaoTotal = (activeScenario.durb * activeScenario.fracDurb[i]) + (activeScenario.dsupl * activeScenario.fracDsup[i]);
                          const obtida = currentResult.garantias_obtidas?.[i] ?? 0;
                          const exigida = activeScenario.garantiaReq[i];
                          return (
                            <tr key={i} className={`border-t ${isDark ? "border-slate-800/50" : "border-slate-200"}`}>
                              <td className="py-2 flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: CURVE_COLORS[i] }}></span><span style={{ color: CURVE_COLORS[i] }}>{lbl}</span></td>
                              <td className={`py-2 ${isDark ? "text-slate-300" : "text-slate-700"}`}>{(vazaoTotal * 1000).toFixed(1)}</td>
                              <td className={`py-2 ${textMuted}`}>{pct(exigida)}</td>
                              <td className={`py-2 font-bold ${obtida >= exigida - 0.01 ? 'text-emerald-500' : 'text-red-500'}`}>{pct(obtida)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {chartDataVolume.length > 0 && (
                    <div className="mt-4">
                      <div className={`flex justify-between items-end mb-3 border-b pb-1 ${isDark ? "border-slate-800" : "border-slate-200"}`}>
                        <h3 className={`text-xs font-mono uppercase ${textMuted}`}>Simulação Histórica de Volumes (%)</h3>
                        {zoomDomain && (<button onClick={() => setZoomDomain(null)} className="text-[10px] font-mono bg-sky-600 hover:bg-sky-500 text-white px-3 py-1 rounded shadow transition-all">🔍 Resetar Zoom</button>)}
                      </div>
                      <div className="h-[300px] w-full select-none">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={activeDataVolume} margin={{ top: 10, right: 10, bottom: 0, left: -20 }} onMouseDown={(e) => e && setRefAreaLeft(e.activeLabel ? String(e.activeLabel) : null)} onMouseMove={(e) => e && refAreaLeft && setRefAreaRight(e.activeLabel ? String(e.activeLabel) : null)} onMouseUp={handleZoom}>
                            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#e2e8f0"} />
                            <XAxis dataKey="data" tick={{ fill: isDark ? "#64748b" : "#475569", fontSize: 10 }} minTickGap={40} />
                            <YAxis domain={[0, 100]} tick={{ fill: isDark ? "#64748b" : "#475569", fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                            <Tooltip content={<CustomTooltip />} />
                            {refAreaLeft && refAreaRight && (<ReferenceArea x1={refAreaLeft} x2={refAreaRight} strokeOpacity={0.3} fill="#0ea5e9" fillOpacity={0.2} />)}
                            <Area isAnimationActive={false} type="linear" dataKey="vol_0" stroke={CURVE_COLORS[0]} strokeWidth={2.5} fill={CURVE_COLORS[0]} fillOpacity={isDark ? 0.2 : 0.4} connectNulls={false} />
                            <Area isAnimationActive={false} type="linear" dataKey="vol_1" stroke={CURVE_COLORS[1]} strokeWidth={2.5} fill={CURVE_COLORS[1]} fillOpacity={isDark ? 0.2 : 0.4} connectNulls={false} />
                            <Area isAnimationActive={false} type="linear" dataKey="vol_2" stroke={CURVE_COLORS[2]} strokeWidth={2.5} fill={CURVE_COLORS[2]} fillOpacity={isDark ? 0.2 : 0.4} connectNulls={false} />
                            <Area isAnimationActive={false} type="linear" dataKey="vol_3" stroke={CURVE_COLORS[3]} strokeWidth={2.5} fill={CURVE_COLORS[3]} fillOpacity={isDark ? 0.2 : 0.4} connectNulls={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className={`text-xs font-mono uppercase mb-2 border-b pb-1 ${textMuted} ${isDark ? "border-slate-800" : "border-slate-200"}`}>Valores das Curvas (% Volume)</h3>
                    <div className="overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                      <table className="w-full text-[10px] font-mono text-center">
                        <thead className={textMuted}><tr><th className="text-left py-1">Nível Meta</th>{MESES_CURTOS.map(m => <th key={m} className="py-1">{m}</th>)}</tr></thead>
                        <tbody>
                          {currentResult.matriz_curvas?.map((curve, idx) => (
                            <tr key={idx} className={`border-t ${isDark ? "border-slate-800/50" : "border-slate-200"}`}>
                              <td className="text-left py-1.5 font-bold" style={{ color: CURVE_COLORS[idx + 1] }}>{NIVEL_LABELS[idx + 1]}</td>
                              {curve.map((val, mi) => (<td key={mi} className={`py-1.5 ${isDark ? "text-slate-300" : "text-slate-700"}`}>{(val * 100).toFixed(1)}</td>))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
