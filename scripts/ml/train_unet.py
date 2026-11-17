"""Entrena una U-Net chica (CPU) para segmentar ambos pies en el termograma.

- Entrada: temperatura normalizada por imagen (percentiles 1–99), reducida a
  120 × 160 (la mitad de la matriz IR de 240 × 320).
- Salida: 3 clases (fondo, pie a la izquierda de la imagen, pie a la derecha).
- Etiquetas: débiles (segmentación clásica refinada, build_labels.py); se
  entrena sólo con las «limpias».
- División train/val POR PACIENTE (20 % de los pacientes a validación).
- Aumento: espejado horizontal (intercambiando las clases 1 <-> 2), rotación
  ±10°, escala 0,9–1,1, desplazamiento ±4 %, jitter de contraste/brillo/gamma
  y ruido.
- Pérdida: entropía cruzada + Dice.
- Guarda el mejor punto de control (Dice de validación) en
  data-local/models/unet-feet.pt y lo exporta a ONNX (unet-feet.onnx).

Uso: python scripts/ml/train_unet.py [épocas]
"""
import json
import math
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import common as C

torch.set_num_threads(C.NUM_THREADS)
torch.manual_seed(0)
np.random.seed(0)

HS, WS = 120, 160
LABELS = C.DATA / "ml" / "labels"
LOG = C.DATA / "ml" / "train_unet.log"


def log(msg):
    print(msg, flush=True)
    with open(LOG, "a", encoding="utf8") as f:
        f.write(msg + "\n")


class Block(nn.Module):
    def __init__(self, a, b, p=0.0):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(a, b, 3, padding=1, bias=False),
            nn.BatchNorm2d(b),
            nn.ReLU(inplace=True),
            nn.Dropout2d(p) if p else nn.Identity(),
            nn.Conv2d(b, b, 3, padding=1, bias=False),
            nn.BatchNorm2d(b),
            nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.net(x)


class UNet(nn.Module):
    """U-Net de 4 niveles (16-32-64-128 canales)."""

    def __init__(self, base=16, n_cls=3):
        super().__init__()
        c = [base, base * 2, base * 4, base * 8]
        self.e1, self.e2, self.e3 = Block(1, c[0]), Block(c[0], c[1]), Block(c[1], c[2])
        self.b = Block(c[2], c[3], p=0.1)
        self.u3, self.d3 = nn.ConvTranspose2d(c[3], c[2], 2, 2), Block(c[3], c[2])
        self.u2, self.d2 = nn.ConvTranspose2d(c[2], c[1], 2, 2), Block(c[2], c[1])
        self.u1, self.d1 = nn.ConvTranspose2d(c[1], c[0], 2, 2), Block(c[1], c[0])
        self.out = nn.Conv2d(c[0], n_cls, 1)

    def forward(self, x):
        e1 = self.e1(x)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        b = self.b(F.max_pool2d(e3, 2))
        d3 = self.d3(torch.cat([self.u3(b), e3], 1))
        d2 = self.d2(torch.cat([self.u2(d3), e2], 1))
        d1 = self.d1(torch.cat([self.u1(d2), e1], 1))
        return self.out(d1)


def prep(key):
    t = torch.from_numpy(C.normalize_temp(np.asarray(C.load_temp(key))))[None, None]
    return F.interpolate(t, size=(HS, WS), mode="bilinear", align_corners=False)[0]


def prep_label(key):
    y = torch.from_numpy(np.load(LABELS / f"{key}.npy").astype(np.int64))[None, None].float()
    return F.interpolate(y, size=(HS, WS), mode="nearest")[0, 0].long()


def augment(x, y):
    """x: B×1×H×W, y: B×H×W (long)."""
    B = x.shape[0]
    flip = torch.rand(B) < 0.5
    x = torch.where(flip[:, None, None, None], x.flip(-1), x)
    yf = y.flip(-1)
    yf = torch.where(yf == 1, 2, torch.where(yf == 2, 1, yf))
    y = torch.where(flip[:, None, None], yf, y)
    ang = (torch.rand(B) * 2 - 1) * math.radians(10)
    sc = 1 + (torch.rand(B) * 2 - 1) * 0.1
    tx, ty = (torch.rand(B) * 2 - 1) * 0.04, (torch.rand(B) * 2 - 1) * 0.04
    cos, sin = torch.cos(ang) / sc, torch.sin(ang) / sc
    theta = torch.stack([torch.stack([cos, -sin, tx], 1), torch.stack([sin, cos, ty], 1)], 1)
    grid = F.affine_grid(theta, list(x.shape), align_corners=False)
    x = F.grid_sample(x, grid, mode="bilinear", padding_mode="border", align_corners=False)
    y = F.grid_sample(y[:, None].float(), grid, mode="nearest", padding_mode="zeros", align_corners=False)
    y = y[:, 0].long()
    a = 1 + (torch.rand(B, 1, 1, 1) * 2 - 1) * 0.2
    b = (torch.rand(B, 1, 1, 1) * 2 - 1) * 0.1
    g = torch.exp((torch.rand(B, 1, 1, 1) * 2 - 1) * 0.3)
    x = (x.clamp(0, None) ** g) * a + b + torch.randn_like(x) * 0.02
    return x, y


def dice_loss(logits, y, n=3):
    p = logits.softmax(1)
    oh = F.one_hot(y, n).permute(0, 3, 1, 2).float()
    inter = (p * oh).sum((0, 2, 3))
    den = p.sum((0, 2, 3)) + oh.sum((0, 2, 3))
    return 1 - ((2 * inter + 1) / (den + 1))[1:].mean()


def evaluate(model, X, Y):
    model.eval()
    d, j = [], []
    with torch.no_grad():
        for i in range(0, len(X), 16):
            pr = model(X[i : i + 16]).argmax(1)
            for a, b in zip(pr.numpy(), Y[i : i + 16].numpy()):
                dd, jj = zip(*[C.dice_iou(a == k, b == k) for k in (1, 2)])
                d.append(np.mean(dd))
                j.append(np.mean(jj))
    return float(np.mean(d)), float(np.mean(j))


def main():
    epochs = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    C.MODELS.mkdir(parents=True, exist_ok=True)
    rows = json.loads((LABELS / "index.json").read_text(encoding="utf8"))
    val_codes = C.patient_split([r["codigo"] for r in rows])
    train = [r for r in rows if r["limpia"] and r["codigo"] not in val_codes]
    val = [r for r in rows if r["limpia"] and r["codigo"] in val_codes]
    log(
        f"--- {time.strftime('%Y-%m-%d %H:%M')} train {len(train)} imgs / val {len(val)} imgs "
        f"(pacientes val {len(val_codes)})"
    )
    Xtr = torch.stack([prep(r["key"]) for r in train])
    Ytr = torch.stack([prep_label(r["key"]) for r in train])
    Xva = torch.stack([prep(r["key"]) for r in val])
    Yva = torch.stack([prep_label(r["key"]) for r in val])
    model = UNet()
    log(f"parámetros: {sum(p.numel() for p in model.parameters())}")
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = epochs * math.ceil(len(train) / 8)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    w = torch.tensor([0.5, 1.0, 1.0])
    best = -1
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(len(Xtr))
        tl, t0 = 0.0, time.time()
        for i in range(0, len(perm), 8):
            idx = perm[i : i + 8]
            x, y = augment(Xtr[idx], Ytr[idx])
            out = model(x)
            loss = F.cross_entropy(out, y, weight=w) + dice_loss(out, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tl += loss.item() * len(idx)
        dv, jv = evaluate(model, Xva, Yva)
        if dv > best:
            best = dv
            torch.save(
                {"state": model.state_dict(), "epoch": ep, "dice": dv, "iou": jv,
                 "val_codes": sorted(val_codes), "hs": HS, "ws": WS},
                C.MODELS / "unet-feet.pt",
            )
        log(f"época {ep + 1}/{epochs} pérdida {tl / len(perm):.4f} val Dice {dv:.4f} IoU {jv:.4f} "
            f"({time.time() - t0:.0f} s)")
    ck = torch.load(C.MODELS / "unet-feet.pt")
    log(f"mejor: época {ck['epoch'] + 1} Dice {ck['dice']:.4f} IoU {ck['iou']:.4f}")
    model.load_state_dict(ck["state"])
    model.eval()
    torch.onnx.export(
        model, torch.zeros(1, 1, HS, WS), str(C.MODELS / "unet-feet.onnx"),
        input_names=["temp"], output_names=["logits"], opset_version=17, dynamo=False,
    )
    log("ONNX: data-local/models/unet-feet.onnx")


if __name__ == "__main__":
    main()
