import os
import json
import sqlite3
import numpy as np
import pyswarms as ps
from numba import njit
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

app = FastAPI(title="SSD Reservatórios API")

# Permite que o React (que roda noutra porta/domínio) converse com esta API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Em produção, podes restringir para o domínio do teu Vercel
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class LimitesPayload(BaseModel):
    reservatorio: str

class SimularPayload(BaseModel):
    cenario_id: str = 'padrao'
    reservatorio: str
    durb_m3s: float
    dsupl_m3s: float
    prob: float = 0.25
    iters: int = 50
    ninicio: int = 1
    mes_inicio: int = 1
    ano_inicio: int = 1911
    mes_fim: int = 12
    ano_fim: int = 2021
    frac_durb: List[float]
    frac_dsup: List[float]
    garantia_req: List[float]


def get_db_path():
    # Na web, o banco de dados geralmente fica na mesma pasta do main.py
    if os.path.exists('banco_site.db'):
        return 'banco_site.db'
    raise Exception("Arquivo banco_site.db não foi encontrado na raiz do projeto.")

@app.get("/api/reservatorios")
def listar_reservatorios():
    try:
        db_path = get_db_path()
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute('SELECT DISTINCT CORPO FROM acudes WHERE CORPO IS NOT NULL ORDER BY CORPO')
        rows = cursor.fetchall()
        conn.close()
        lista_acudes = [str(r[0]).strip() for r in rows if str(r[0]).strip()]
        return {"status": "reservatorios", "lista": lista_acudes}
    except Exception as e:
        return {"status": "erro", "mensagem": f"Erro ao listar açudes: {str(e)}"}

@app.post("/api/limites")
def buscar_limites_bd(payload: LimitesPayload):
    try:
        reservatorio = payload.reservatorio
        meses_map = {"JAN":1, "FEV":2, "MAR":3, "ABR":4, "MAI":5, "JUN":6, "JUL":7, "AGO":8, "SET":9, "OUT":10, "NOV":11, "DEZ":12}
        db_path = get_db_path()
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute('SELECT Ano, "Mês" FROM vazoes WHERE nome_reservatorio LIKE ? ORDER BY Ano ASC LIMIT 1', (f"%{reservatorio}%",))
        row_min = cursor.fetchone()
        cursor.execute('SELECT Ano, "Mês" FROM vazoes WHERE nome_reservatorio LIKE ? ORDER BY Ano DESC LIMIT 1', (f"%{reservatorio}%",))
        row_max = cursor.fetchone()
        conn.close()
        
        if row_min and row_max:
            mes_min = meses_map.get(str(row_min[1]).upper()[:3], 1) if row_min[1] else 1
            mes_max = meses_map.get(str(row_max[1]).upper()[:3], 12) if row_max[1] else 12
            return {"status": "limites", "ano_min": int(row_min[0]), "mes_min": int(mes_min), "ano_max": int(row_max[0]), "mes_max": int(mes_max)}
        else:
            return {"status": "limites", "ano_min": 1911, "mes_min": 1, "ano_max": 2021, "mes_max": 12}
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}

def carregar_dados_fisicos(reservatorio, mes_ini, ano_ini, mes_fim, ano_fim):
    meses_map = {"JAN":1, "FEV":2, "MAR":3, "ABR":4, "MAI":5, "JUN":6, "JUL":7, "AGO":8, "SET":9, "OUT":10, "NOV":11, "DEZ":12}
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('SELECT COD, "CAPAC (m³)", "Est. Evap." FROM acudes WHERE CORPO = ? OR CORPO LIKE ? LIMIT 1', (reservatorio, f"%{reservatorio}%"))
    acude_row = cursor.fetchone()
    if not acude_row:
        conn.close()
        raise Exception(f"Açude '{reservatorio}' não encontrado na tabela 'acudes'.")
        
    cod_acude, capac_m3, est_evap = acude_row
    cap_hm3 = float(capac_m3) / 1e6
    
    cursor.execute('SELECT "VOLUME (m³)", "AREA (km²)" FROM cav WHERE COD = ? OR CAST(COD AS REAL) = ? ORDER BY CAST("VOLUME (m³)" AS REAL) ASC', (str(cod_acude), cod_acude))
    cav_rows = cursor.fetchall()
    if not cav_rows:
        conn.close()
        raise Exception(f"CAV não encontrada para o açude COD {cod_acude}.")
        
    cav_vol = np.array([float(r[0]) / 1e6 for r in cav_rows])
    cav_area = np.array([float(r[1]) for r in cav_rows])
    
    est_evap_str = str(int(float(est_evap))) if est_evap else ""
    cursor.execute('SELECT JAN, FEV, MAR, ABR, MAI, JUN, JUL, AGO, "SET", OUT, NOV, DEZ FROM evaporacao WHERE COD = ? OR COD = ? LIMIT 1', (est_evap_str, str(est_evap)))
    evap_row = cursor.fetchone()
    evap_mensal = np.array([float(x) if x else 0.0 for x in evap_row]) if evap_row else np.ones(12) * 150.0 
        
    cursor.execute('SELECT Ano, "Mês", "Vazão (m³/s)" FROM vazoes WHERE nome_reservatorio LIKE ?', (f"%{reservatorio}%",))
    vazoes_rows = cursor.fetchall()
    conn.close()
    
    vazoes_filtradas = []
    for ano, mes_str, vazao in vazoes_rows:
        ano = int(ano)
        mes_num = meses_map.get(str(mes_str).upper()[:3], 1)
        data_atual = ano * 12 + mes_num
        data_inicio = ano_ini * 12 + mes_ini
        data_fim = ano_fim * 12 + mes_fim
        if data_inicio <= data_atual <= data_fim:
            vazoes_filtradas.append((ano, mes_num, float(vazao)))
            
    vazoes_filtradas.sort(key=lambda x: (x[0], x[1]))
    aflu_serie = np.array([x[2] for x in vazoes_filtradas])
    evap_serie = np.array([evap_mensal[x[1] - 1] for x in vazoes_filtradas])
    
    return aflu_serie, evap_serie, cap_hm3, cav_vol, cav_area


@njit
def interpola(x_vals, y_vals, x):
    if x <= x_vals[0]: return y_vals[0]
    if x >= x_vals[-1]: return y_vals[-1]
    return np.interp(x, x_vals, y_vals)

@njit
def dinamica_mensal_fast(vol_ini, aflu_hm3, evap_m, ret_hm3, vol_min, vol_max, cav_vol, cav_area):
    area_ini = interpola(cav_vol, cav_area, vol_ini)
    vol = vol_ini + aflu_hm3 - ret_hm3 - (evap_m * area_ini)
    area_fin = interpola(cav_vol, cav_area, vol)
    area_med = (area_ini + area_fin) / 2.0
    vol = vol_ini + aflu_hm3 - ret_hm3 - (evap_m * area_med)
    
    retirada_efetiva = ret_hm3
    if vol < vol_min:
        retirada_orig = retirada_efetiva
        retirada_efetiva = retirada_efetiva - (vol_min - vol)
        if retirada_efetiva >= 0:
            vol = vol_min
        else:
            vol = vol + retirada_orig
            retirada_efetiva = 0.0
            if vol < 0: vol = 0.0
            
    vertimento = 0.0
    if vol > vol_max:
        vertimento = vol - vol_max
        vol = vol_max
        
    return vol, retirada_efetiva, vertimento, evap_m * area_med

@njit
def calculo_volume_meta_fast(niveis_metas, aflu_prob, evap_ano, dem_total_hm3, cap_hm3, cav_vol, cav_area, ninicio):
    aflu_zero = np.zeros(12)
    vmeta = np.zeros((len(niveis_metas), 12))
    vol_util = cap_hm3 
    
    for vm in range(len(niveis_metas)):
        vol_ini = niveis_metas[vm] * vol_util
        v2_fim = np.zeros(12)
        v = vol_ini
        for i in range(12):
            v, _, _, _ = dinamica_mensal_fast(v, -aflu_zero[i], -evap_ano[i], -dem_total_hm3, 0.0, cap_hm3, cav_vol, cav_area)
            v2_fim[i] = v
        v2_rev = np.zeros(12)
        for i in range(12): v2_rev[i] = v2_fim[11 - i]
            
        v3_fim = np.zeros(12)
        v = vol_ini
        for i in range(12):
            v, _, _, _ = dinamica_mensal_fast(v, aflu_prob[i], evap_ano[i], dem_total_hm3, 0.0, cap_hm3, cav_vol, cav_area)
            v3_fim[i] = v
        v3_shifted = np.zeros(12)
        v3_shifted[0] = vol_ini
        for i in range(11): v3_shifted[i+1] = v3_fim[i]
            
        vmeta_aux = np.zeros(12)
        for i in range(12):
            vmeta_aux[i] = min(v2_rev[i], v3_shifted[i]) / vol_util
            
        if ninicio != 1:
            idx_split = 13 - ninicio
            for i in range(13 - ninicio): vmeta[vm, (ninicio - 1) + i] = vmeta_aux[i]
            for i in range(ninicio - 1): vmeta[vm, i] = vmeta_aux[idx_split + i]
        else:
            for i in range(12): vmeta[vm, i] = vmeta_aux[i]
    return vmeta

@njit
def engine_simulacao_temporal(nmetas, aflu_hm3, evap_serie_m, ret_vec_hm3, cap_hm3, cav_vol, cav_area, mes_inicio):
    num_meses = len(aflu_hm3)
    num_estados = len(ret_vec_hm3)
    falhas = np.zeros(num_estados)
    vol = cap_hm3 * 0.5 
    
    for i in range(num_meses):
        idx_mes = (mes_inicio - 1 + i) % 12
        vol_perc = vol / cap_hm3
        coluna_meta = np.empty(nmetas.shape[0])
        for k in range(nmetas.shape[0]): coluna_meta[k] = nmetas[k, idx_mes]
            
        est_hidr = np.searchsorted(coluna_meta, vol_perc)
        idx_alvo = (num_estados - 1) - est_hidr
        if idx_alvo < 0: idx_alvo = 0
        if idx_alvo >= num_estados: idx_alvo = num_estados - 1
        
        vol, ret_efetiva, _, _ = dinamica_mensal_fast(vol, aflu_hm3[i], evap_serie_m[i], ret_vec_hm3[idx_alvo], 0.0, cap_hm3, cav_vol, cav_area)
        for k in range(num_estados):
            if ret_efetiva < ret_vec_hm3[k]: falhas[k] += 1
                
    garantias = np.empty(num_estados)
    for k in range(num_estados): garantias[k] = 1.0 - (falhas[k] / num_meses)
    return garantias

@njit
def simular_serie_historica_fast(nmetas, aflu_hm3, evap_serie_m, ret_vec_hm3, cap_hm3, cav_vol, cav_area, mes_inicio):
    num_meses = len(aflu_hm3)
    num_estados = len(ret_vec_hm3)
    vol = cap_hm3 * 0.5 
    historico_vol = np.zeros(num_meses) 
    
    for i in range(num_meses):
        idx_mes = (mes_inicio - 1 + i) % 12
        vol_perc = vol / cap_hm3
        coluna_meta = np.empty(nmetas.shape[0])
        for k in range(nmetas.shape[0]): coluna_meta[k] = nmetas[k, idx_mes]
            
        est_hidr = np.searchsorted(coluna_meta, vol_perc)
        idx_alvo = (num_estados - 1) - est_hidr
        if idx_alvo < 0: idx_alvo = 0
        if idx_alvo >= num_estados: idx_alvo = num_estados - 1
        
        vol, _, _, _ = dinamica_mensal_fast(vol, aflu_hm3[i], evap_serie_m[i], ret_vec_hm3[idx_alvo], 0.0, cap_hm3, cav_vol, cav_area)
        historico_vol[i] = vol
    return historico_vol

def gerar_resultado_final(niveis_metas, aflu_hm3, evap_serie_m, dem_total_hm3, ret_vec_hm3, cap_hm3, cav_vol, cav_area, aflu_prob, evap_ano, ninicio, mes_inicio):
    nmetas = calculo_volume_meta_fast(niveis_metas, aflu_prob, evap_ano, dem_total_hm3, cap_hm3, cav_vol, cav_area, ninicio)
    garantias = engine_simulacao_temporal(nmetas, aflu_hm3, evap_serie_m, ret_vec_hm3, cap_hm3, cav_vol, cav_area, mes_inicio)
    return garantias, nmetas

def funcao_objetivo_pso(x_matrix, aflu_hm3, evap_serie_m, dem_total_hm3, ret_vec_hm3, cap_hm3, cav_vol, cav_area, garantia_req, aflu_prob, evap_ano, ninicio, mes_inicio):
    n_particles = x_matrix.shape[0]
    resultados = np.zeros(n_particles)
    for i in range(n_particles):
        niveis_metas = x_matrix[i] / 10.0
        if not np.all(np.diff(niveis_metas) >= 0.02):
            resultados[i] = 1e7
            continue
        nmetas = calculo_volume_meta_fast(niveis_metas, aflu_prob, evap_ano, dem_total_hm3, cap_hm3, cav_vol, cav_area, ninicio)
        if np.min(nmetas) <= 0.05:
            resultados[i] = 1e6
            continue
        garantias = engine_simulacao_temporal(nmetas, aflu_hm3, evap_serie_m, ret_vec_hm3, cap_hm3, cav_vol, cav_area, mes_inicio)
        resultados[i] = np.sum(((garantias - np.array(garantia_req)) / np.array(garantia_req)) ** 2)
    return resultados



def simular_generator(payload: SimularPayload):
    try:
        aflu, evap, cap_hm3, cav_vol, cav_area = carregar_dados_fisicos(
            payload.reservatorio, payload.mes_inicio, payload.ano_inicio, payload.mes_fim, payload.ano_fim
        )

        fator_conv = 2.592
        aflu_hm3 = aflu * fator_conv
        dem_total_hm3 = (payload.durb_m3s + payload.dsupl_m3s) * fator_conv
        ret_vec_hm3 = (payload.durb_m3s * fator_conv * np.array(payload.frac_durb)) + (payload.dsupl_m3s * fator_conv * np.array(payload.frac_dsup))
        evap_serie_m = evap / 1000.0

        meses_serie = np.array([(payload.mes_inicio - 1 + i) % 12 + 1 for i in range(len(aflu_hm3))])
        aflu_prob_12 = np.zeros(12)
        evap_ano_12 = np.zeros(12)
        for m in range(1, 13):
            idx = (meses_serie == m)
            aflu_prob_12[m-1] = np.quantile(aflu_hm3[idx], payload.prob) if np.any(idx) else 0.0
            evap_ano_12[m-1] = evap_serie_m[idx][0] if np.any(idx) else 0.0
            
        if payload.ninicio != 1:
            idx_start = payload.ninicio - 1
            aflu_prob = np.concatenate([aflu_prob_12[idx_start:], aflu_prob_12[:idx_start]])
            evap_ano = np.concatenate([evap_ano_12[idx_start:], evap_ano_12[:idx_start]])
        else:
            aflu_prob, evap_ano = aflu_prob_12, evap_ano_12

        n_vars = len(payload.frac_durb) - 1 
        bounds = (np.ones(n_vars), np.ones(n_vars) * 9.0)
        optimizer = ps.single.GlobalBestPSO(n_particles=200, dimensions=n_vars, options={'c1': 0.5, 'c2': 0.3, 'w': 0.9}, bounds=bounds)

        kwargs = dict(aflu_hm3=aflu_hm3, evap_serie_m=evap_serie_m, dem_total_hm3=dem_total_hm3, ret_vec_hm3=ret_vec_hm3, cap_hm3=cap_hm3, cav_vol=cav_vol, cav_area=cav_area, garantia_req=payload.garantia_req, aflu_prob=aflu_prob, evap_ano=evap_ano, ninicio=payload.ninicio, mes_inicio=payload.mes_inicio)

        passos_por_bloco = 5
        total_blocos = max(1, payload.iters // passos_por_bloco)
        resto = payload.iters % passos_por_bloco
        best_cost, best_pos = float('inf'), None

        # Gerador: envia blocos de progresso aos poucos
        for bloco in range(1, total_blocos + 1):
            cost, pos = optimizer.optimize(funcao_objetivo_pso, iters=passos_por_bloco, verbose=False, **kwargs)
            best_cost, best_pos = cost, pos
            progresso_data = {
                "status": "progresso", "cenario_id": payload.cenario_id,
                "iteracao": bloco * passos_por_bloco, "total_iteracoes": payload.iters
            }
            yield f"data: {json.dumps(progresso_data)}\n\n"

        if resto > 0:
            cost, pos = optimizer.optimize(funcao_objetivo_pso, iters=resto, verbose=False, **kwargs)
            best_cost, best_pos = cost, pos
            progresso_data = {"status": "progresso", "cenario_id": payload.cenario_id, "iteracao": payload.iters, "total_iteracoes": payload.iters}
            yield f"data: {json.dumps(progresso_data)}\n\n"

        melhores_metas = np.sort(best_pos / 10.0)
        garantias_finais, curvas_finais = gerar_resultado_final(melhores_metas, aflu_hm3, evap_serie_m, dem_total_hm3, ret_vec_hm3, cap_hm3, cav_vol, cav_area, aflu_prob, evap_ano, payload.ninicio, payload.mes_inicio)
        volumes_hist = simular_serie_historica_fast(curvas_finais, aflu_hm3, evap_serie_m, ret_vec_hm3, cap_hm3, cav_vol, cav_area, payload.mes_inicio)
        volumes_hist = np.where(np.isfinite(volumes_hist), volumes_hist, 0.0)
        
        resultado_final = {
            "status": "sucesso", "cenario_id": payload.cenario_id, "custo_final": float(best_cost),
            "niveis_meta": melhores_metas[::-1].tolist(), "garantias_obtidas": garantias_finais.tolist(),
            "matriz_curvas": curvas_finais[::-1].tolist(), "volumes_historicos": volumes_hist.tolist(),
            "mes_inicio": payload.mes_inicio, "ano_inicio": payload.ano_inicio, "capacidade_hm3": cap_hm3
        }
        yield f"data: {json.dumps(resultado_final)}\n\n"

    except Exception as e:
        erro_data = {"status": "erro", "cenario_id": payload.cenario_id, "mensagem": str(e)}
        yield f"data: {json.dumps(erro_data)}\n\n"

@app.post("/api/simular")
def simular_endpoint(payload: SimularPayload):
    # StreamingResponse mantém a ligação aberta enquanto o PSO calcula
    return StreamingResponse(simular_generator(payload), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    import os
    porta = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=porta)
