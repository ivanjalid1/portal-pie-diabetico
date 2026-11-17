"""Genera las etiquetas débiles mejoradas y elige el subconjunto «limpio» para entrenar.

Salida (local): data-local/ml/labels/<clave>.npy (uint8 0/1/2) y
data-local/ml/labels/index.json con, por archivo: código del paciente, toma,
calidad clásica, relación largo/ancho de cada pie, píxeles recortados en el
talón, dedos recuperados y si entra al entrenamiento (`limpia`).

Criterio de «limpia» (todas):
  - la segmentación clásica no está marcada «a revisar» (calidad ≥ 0,6);
  - en la etiqueta refinada, cada pie tiene largo/ancho entre 2,1 y 3,4;
  - el área del pie menor es ≥ 80 % de la del mayor.
"""
import json

import numpy as np

import common as C

OUT = C.DATA / "ml" / "labels"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for e in C.load_index():
        if not e.get("exportado"):
            continue
        t = C.load_temp(e["key"])
        cls = C.load_classic(e["key"])
        ref, info = C.refine_labels(cls, t)
        np.save(OUT / f"{e['key']}.npy", ref)
        ratios = [C.length_ratio(ref == k) for k in (1, 2)]
        areas = [int((ref == k).sum()) for k in (1, 2)]
        limpia = (
            bool(e.get("ok"))
            and (e.get("calidad") or 0) >= 0.6
            and all(r is not None and 2.1 <= r <= C.MAX_LARGO_ANCHO for r in ratios)
            and min(areas) >= 0.8 * max(max(areas), 1)
        )
        rows.append(
            {
                "key": e["key"],
                "codigo": e["codigo"],
                "toma": e["toma"],
                "calidad": e.get("calidad"),
                "okClasica": bool(e.get("ok")),
                "ratios": ratios,
                "areas": areas,
                "corteTalon": sum(v.get("corteTalon", 0) + v.get("corteLateralTalon", 0) for v in info.values()),
                "dedosRecuperados": sum(v.get("dedosRecuperados", 0) for v in info.values()),
                "limpia": limpia,
            }
        )
    (OUT / "index.json").write_text(json.dumps(rows), encoding="utf8")
    n = len(rows)
    print(f"etiquetas: {n}; limpias: {sum(r['limpia'] for r in rows)}; "
          f"con recorte en talón: {sum(r['corteTalon'] > 0 for r in rows)}; "
          f"con dedos recuperados (>50 px): {sum(r['dedosRecuperados'] > 50 for r in rows)}; "
          f"pacientes: {len(set(r['codigo'] for r in rows))}")


if __name__ == "__main__":
    main()
