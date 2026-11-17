"""Utilidades compartidas por los scripts de ML (U-Net, TCI, modelos).

Todo lo que leen y escriben está en data-local/ (ignorada por git y Vercel).
Nunca imprimen nombres ni datos identificatorios: sólo claves, códigos y conteos.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

# La consola de Windows usa cp1252: se fuerza UTF-8 para los textos con símbolos.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data-local"
CACHE = DATA / "ml" / "cache"
MODELS = DATA / "models"
H, W = 240, 320

# El repositorio usa 16 hilos lógicos, pero la máquina tiene poca memoria: 2–4 hilos.
NUM_THREADS = int(os.environ.get("ML_THREADS", "3"))


def load_index() -> list[dict]:
    return json.loads((CACHE / "index.json").read_text(encoding="utf8"))


def load_temp(key: str) -> np.ndarray:
    return np.load(CACHE / f"{key}_t.npy", mmap_mode="r")


def load_classic(key: str) -> np.ndarray:
    return np.load(CACHE / f"{key}_cls.npy")


def normalize_temp(t: np.ndarray) -> np.ndarray:
    """Normalización robusta por imagen (percentiles 1–99 → 0–1)."""
    t = np.asarray(t, dtype=np.float32)
    lo, hi = np.percentile(t, [1, 99])
    return np.clip((t - lo) / max(hi - lo, 1e-3), -0.5, 1.5).astype(np.float32)


def _largest(mask: np.ndarray) -> np.ndarray:
    lab, n = ndi.label(mask)
    if n == 0:
        return mask.astype(bool)
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def foot_axis(mask: np.ndarray):
    """Centroide y eje principal (hacia los dedos = −y) de una máscara, como footFrame()."""
    ys, xs = np.nonzero(mask)
    cx, cy = xs.mean(), ys.mean()
    dx, dy = xs - cx, ys - cy
    sxx, syy, sxy = (dx * dx).sum(), (dy * dy).sum(), (dx * dy).sum()
    th = 0.5 * np.arctan2(2 * sxy, sxx - syy)
    e1 = np.array([np.cos(th), np.sin(th)])
    if abs(e1[1]) < abs(e1[0]):
        e1 = np.array([-e1[1], e1[0]])
    if e1[1] > 0:
        e1 = -e1
    e2 = np.array([-e1[1], e1[0]])
    v = dx * e1[0] + dy * e1[1]
    u = dx * e2[0] + dy * e2[1]
    return xs, ys, u, v


# Relación largo / ancho del antepié por encima de la cual se considera que la
# máscara incluye pierna o tela más allá del talón (la típica es ≈ 2,6).
MAX_LARGO_ANCHO = 3.4


def refine_foot(mask: np.ndarray) -> tuple[np.ndarray, dict]:
    """Limpia la máscara de UN pie con morfología y un prior de forma.

    1. Apertura 3×3, componente mayor y relleno de huecos.
    2. Prior de forma en el talón: con el eje principal y el ancho del antepié
       (10–55 % del largo desde la punta), se recorta lo que excede
       MAX_LARGO_ANCHO × ancho desde la punta de los dedos (pierna o tela) y,
       en el último 30 % del pie, lo que sobresale lateralmente más de 0,6 ×
       ancho del eje del antepié (el talón es más angosto que el antepié).
    """
    info = {"corteTalon": 0, "corteLateralTalon": 0}
    m = ndi.binary_opening(mask.astype(bool), structure=np.ones((3, 3)))
    if m.sum() < 250:
        return mask.astype(bool), info
    m = ndi.binary_fill_holes(_largest(m))
    for _ in range(2):
        xs, ys, u, v = foot_axis(m)
        vmax, vmin = np.percentile(v, 99.5), np.percentile(v, 0.5)
        L = vmax - vmin
        f = (vmax - v) / max(L, 1)
        front = u[(f >= 0.1) & (f <= 0.55)]
        if front.size < 20:
            break
        wid = np.percentile(front, 99) - np.percentile(front, 1)
        uc = 0.5 * (np.percentile(front, 99) + np.percentile(front, 1))
        drop = np.zeros_like(v, dtype=bool)
        if L > MAX_LARGO_ANCHO * wid:
            cut = vmax - MAX_LARGO_ANCHO * wid
            d = v < cut
            info["corteTalon"] += int(d.sum())
            drop |= d
        heel = (vmax - v) / max(min(L, MAX_LARGO_ANCHO * wid), 1) > 0.7
        lat = heel & (np.abs(u - uc) > 0.6 * wid)
        info["corteLateralTalon"] += int((lat & ~drop).sum())
        drop |= lat
        if not drop.any():
            break
        m[ys[drop], xs[drop]] = False
        m = ndi.binary_opening(m, structure=np.ones((3, 3)))
        if m.sum() < 250:
            break
        m = ndi.binary_fill_holes(_largest(m))
    return m, info


def _otsu(vals: np.ndarray) -> float:
    hist, edges = np.histogram(vals, bins=128)
    p = hist.astype(np.float64)
    w0 = np.cumsum(p)
    w1 = w0[-1] - w0
    c = 0.5 * (edges[:-1] + edges[1:])
    m0 = np.cumsum(p * c) / np.maximum(w0, 1)
    m1 = ((p * c).sum() - np.cumsum(p * c)) / np.maximum(w1, 1)
    between = w0 * w1 * (m0 - m1) ** 2
    return float(c[int(np.argmax(between[:-1]))])


def expand_foot(t: np.ndarray, m: np.ndarray, other: np.ndarray) -> tuple[np.ndarray, int]:
    """Recupera partes frías del pie (típicamente los dedos) que el crecimiento
    de regiones dejó afuera: umbral de Otsu LOCAL (pie vs. fondo cercano) dentro
    del marco del pie, sólo hacia los dedos (hasta +35 % del largo) y dentro del
    ancho del antepié. Nunca toma píxeles del otro pie ni crece hacia el talón."""
    if m.sum() < 250:
        return m, 0
    xs, ys, u, v = foot_axis(m)
    vmax, vmin = np.percentile(v, 99.5), np.percentile(v, 0.5)
    L = vmax - vmin
    f = (vmax - v) / max(L, 1)
    front = u[(f >= 0.1) & (f <= 0.55)]
    if front.size < 20:
        return m, 0
    u0, u1 = np.percentile(front, 1), np.percentile(front, 99)
    cx, cy = xs.mean(), ys.mean()
    # e1/e2 a partir de un punto: se recalculan como en foot_axis.
    yy, xx = np.mgrid[0 : m.shape[0], 0 : m.shape[1]]
    # Reconstrucción de los ejes: regresión de (u, v) sobre (x, y) del propio pie.
    A = np.stack([xs - cx, ys - cy], 1)
    e1 = np.linalg.lstsq(A, v, rcond=None)[0]
    e2 = np.linalg.lstsq(A, u, rcond=None)[0]
    V = (xx - cx) * e1[0] + (yy - cy) * e1[1]
    U = (xx - cx) * e2[0] + (yy - cy) * e2[1]
    wid = u1 - u0
    frame = (U > u0 - 0.08 * wid) & (U < u1 + 0.08 * wid) & (V < vmax + 0.35 * L) & (V > vmin)
    ring = ndi.binary_dilation(m, iterations=12) & ~m
    t = np.asarray(t, dtype=np.float32)
    vals = np.concatenate([t[m], t[ring & ~other]])
    if vals.size < 100:
        return m, 0
    thr = _otsu(vals)
    cand = (t > thr) & frame & ~other
    cand = ndi.binary_opening(cand, structure=np.ones((3, 3)))
    lab, _ = ndi.label(cand | m)
    keep = np.isin(lab, np.unique(lab[m]))
    keep &= ~ndi.binary_dilation(other, iterations=1)
    out = ndi.binary_fill_holes(keep | m)
    # Se informan sólo los píxeles nuevos a más de 2 px del contorno original (no el borde difuso).
    return out, int((out & ~ndi.binary_dilation(m, iterations=2)).sum())


def refine_labels(cls: np.ndarray, t: np.ndarray | None = None) -> tuple[np.ndarray, dict]:
    """Etiqueta débil mejorada: morfología + prior de forma en el talón y, si se
    da la temperatura, recuperación de dedos fríos por Otsu local."""
    out = np.zeros_like(cls, dtype=np.uint8)
    infos = {}
    feet = {}
    for k in (1, 2):
        m = cls == k
        if m.sum() < 250:
            continue
        feet[k], infos[k] = refine_foot(m)
    if t is not None and len(feet) == 2:
        for k in (1, 2):
            o = 3 - k
            grown, added = expand_foot(t, feet[k], feet[o])
            infos[k]["dedosRecuperados"] = added
            feet[k] = grown
    for k, m in feet.items():
        out[m & (out == 0)] = k
    return out, infos


def length_ratio(mask: np.ndarray) -> float | None:
    """Largo / ancho del antepié de un pie (indicador automático de fuga en el talón)."""
    if mask.sum() < 250:
        return None
    _, _, u, v = foot_axis(mask)
    vmax, vmin = np.percentile(v, 99.5), np.percentile(v, 0.5)
    L = vmax - vmin
    f = (vmax - v) / max(L, 1)
    front = u[(f >= 0.1) & (f <= 0.55)]
    if front.size < 20:
        return None
    wid = np.percentile(front, 99) - np.percentile(front, 1)
    return float(L / max(wid, 1))


def dice_iou(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    a, b = a.astype(bool), b.astype(bool)
    inter = (a & b).sum()
    s = a.sum() + b.sum()
    union = (a | b).sum()
    return (2 * inter / s if s else 1.0), (inter / union if union else 1.0)


def patient_split(codes: list[str], val_frac: float = 0.2, seed: int = 7) -> set[str]:
    """Conjunto de pacientes de validación (división por PACIENTE, no por imagen)."""
    uniq = sorted(set(codes))
    rng = np.random.default_rng(seed)
    rng.shuffle(uniq)
    return set(uniq[: max(1, int(round(len(uniq) * val_frac)))])


def overlay(t: np.ndarray, labels_list: list[np.ndarray], colors=None) -> np.ndarray:
    """RGB uint8: temperatura en grises + contornos de cada etiquetado (para revisión visual)."""
    colors = colors or [(255, 60, 60), (60, 220, 255), (255, 220, 0)]
    g = (np.clip(normalize_temp(t), 0, 1) * 255).astype(np.uint8)
    rgb = np.stack([g, g, g], -1)
    for lab, col in zip(labels_list, colors):
        for k in (1, 2):
            m = lab == k
            edge = m & ~ndi.binary_erosion(m)
            rgb[edge] = col
    return rgb
