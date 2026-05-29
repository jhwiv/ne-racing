#!/usr/bin/env python3
"""
fit_logit.py — fit a conditional logistic regression on the v2 sub-scores.

Conditional logit (a.k.a. McFadden's choice model) is the right tool here because
the "choice set" (the field) varies race by race. For each race with N_i horses,
we model:

    P(horse h wins race i) = exp(β · x_{i,h}) / Σ_k exp(β · x_{i,k})

and maximize the log-likelihood:

    ℓ(β) = Σ_i [ β · x_{i, winner(i)}  −  log Σ_k exp(β · x_{i,k}) ]

This is the same softmax used by scoring.js v2 (with temperature = 1), so the
fitted β replaces the hand-picked 6-vector [0.35, 0.20, 0.15, 0.15, 0.10, 0.05]
that's currently the composite weighting.

Input:  JSONL produced by scripts/training/extract_features.js
Output: data/weights/v2.json with weights, standard errors (Hessian-based),
        n_races, date_range, feature names, and a "trained_at" timestamp.

Usage:
    python3 scripts/training/fit_logit.py \\
        --in data/weights/_features.jsonl \\
        --out data/weights/v2.json

A small L2 penalty (--l2, default 0.001) is included to keep the optimum
identifiable when a feature has near-zero variance across the corpus (very
common in early small-sample windows). The penalty is reported in the output.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize


FEATURES = ['speed', 'class', 'pace', 'tj', 'bias', 'fresh']
SUBSCORE_SCALE = 100.0  # features are 0..100 in scoring.js; we rescale to 0..1


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f'[fit] skipping malformed JSONL row: {e}', file=sys.stderr)
    return rows


def assemble(rows: list[dict]) -> tuple[list[np.ndarray], np.ndarray]:
    """Convert JSONL rows into (X_list, y) where X_list[i] is (n_i, k) and y[i] is winner row index."""
    X_list = []
    y_list = []
    for r in rows:
        feats = r.get('features')
        if not feats:
            continue
        X = np.asarray(feats, dtype=float) / SUBSCORE_SCALE  # rescale to 0..1
        if X.ndim != 2 or X.shape[1] != len(FEATURES):
            print(f'[fit] skipping race {r.get("raceId")}: wrong feature shape {X.shape}', file=sys.stderr)
            continue
        widx = r.get('winnerIdx')
        if widx is None or not (0 <= int(widx) < X.shape[0]):
            continue
        X_list.append(X)
        y_list.append(int(widx))
    return X_list, np.asarray(y_list, dtype=int)


def neg_log_lik(beta: np.ndarray, X_list: list[np.ndarray], y: np.ndarray, l2: float) -> float:
    nll = 0.0
    for i, X in enumerate(X_list):
        u = X @ beta
        # log-sum-exp with numerical stability
        m = float(np.max(u))
        lse = m + np.log(np.sum(np.exp(u - m)))
        nll -= u[y[i]] - lse
    if l2 > 0:
        nll += 0.5 * l2 * float(np.dot(beta, beta))
    return nll


def grad_neg_log_lik(beta: np.ndarray, X_list: list[np.ndarray], y: np.ndarray, l2: float) -> np.ndarray:
    k = beta.shape[0]
    g = np.zeros(k, dtype=float)
    for i, X in enumerate(X_list):
        u = X @ beta
        m = float(np.max(u))
        e = np.exp(u - m)
        p = e / np.sum(e)
        # gradient of negative log-lik:  Σ_k p_k x_k  -  x_winner
        g += X.T @ p - X[y[i]]
    if l2 > 0:
        g += l2 * beta
    return g


def hessian(beta: np.ndarray, X_list: list[np.ndarray], y: np.ndarray, l2: float) -> np.ndarray:
    """Observed Fisher information; used for standard errors."""
    k = beta.shape[0]
    H = np.zeros((k, k), dtype=float)
    for X in X_list:
        u = X @ beta
        m = float(np.max(u))
        e = np.exp(u - m)
        p = e / np.sum(e)
        # weighted covariance of features under p_i
        mean_x = X.T @ p                             # (k,)
        # E[xx^T] = Σ p_k x_k x_k^T
        Exx = (X.T * p) @ X                          # (k,k)
        H += Exx - np.outer(mean_x, mean_x)
    if l2 > 0:
        H += l2 * np.eye(k)
    return H


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--in', dest='inp', required=True, help='input JSONL from extract_features.js')
    ap.add_argument('--out', dest='out', required=True, help='output weights JSON path')
    ap.add_argument('--l2', type=float, default=1e-3, help='ridge penalty (default 0.001)')
    ap.add_argument('--min-races', type=int, default=200,
                    help='minimum n_races to write a weights file (default 200)')
    ap.add_argument('--write-anyway', action='store_true',
                    help='write the weights file even when below --min-races (status=insufficient)')
    args = ap.parse_args()

    in_path = Path(args.inp)
    out_path = Path(args.out)
    if not in_path.exists():
        print(f'[fit] input not found: {in_path}', file=sys.stderr)
        return 2

    rows = load_jsonl(in_path)
    X_list, y = assemble(rows)
    n_races = len(X_list)
    print(f'[fit] loaded {len(rows)} JSONL rows, {n_races} usable races', file=sys.stderr)

    if n_races == 0:
        print('[fit] no usable races; nothing to fit', file=sys.stderr)
        return 1

    # Collect date range for provenance
    dates = sorted({r['date'] for r in rows if r.get('date')})
    date_range = {'from': dates[0] if dates else None, 'to': dates[-1] if dates else None}

    insufficient = n_races < args.min_races
    if insufficient and not args.write_anyway:
        print(f'[fit] only {n_races} races (< --min-races={args.min_races}); not writing weights.', file=sys.stderr)
        print('[fit] re-run with --write-anyway to emit a diagnostic file regardless.', file=sys.stderr)
        return 3

    # Initial point: hand-picked weights divided by 100 (since we rescaled X).
    # When X is in 0..1, the equivalent of the v2 hand-picked weighted-sum-on-100 is
    # 100x — but conditional logit is invariant to the additive constant and the
    # softmax already absorbs scale, so we start at a modest magnitude and let the
    # optimizer find the calibrated scale.
    beta0 = np.array([3.5, 2.0, 1.5, 1.5, 1.0, 0.5], dtype=float)

    res = minimize(
        fun=lambda b: neg_log_lik(b, X_list, y, args.l2),
        x0=beta0,
        jac=lambda b: grad_neg_log_lik(b, X_list, y, args.l2),
        method='L-BFGS-B',
        options={'maxiter': 500, 'ftol': 1e-10, 'gtol': 1e-8},
    )

    if not res.success:
        print(f'[fit] optimizer did not converge: {res.message}', file=sys.stderr)
        # Fall through anyway; emit current point with a warning.

    beta = res.x
    nll_at_min = float(res.fun)

    # Standard errors from inverse Hessian
    H = hessian(beta, X_list, y, args.l2)
    try:
        cov = np.linalg.inv(H)
        se = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    except np.linalg.LinAlgError:
        se = np.full_like(beta, np.nan)

    # Baseline log-likelihood: uniform over field
    nll_null = 0.0
    for X in X_list:
        nll_null += np.log(X.shape[0])
    pseudo_r2 = float(1.0 - (nll_at_min - 0.5 * args.l2 * float(np.dot(beta, beta))) / nll_null)

    # Hit rate: top-prob horse vs actual winner
    hits = 0
    for i, X in enumerate(X_list):
        u = X @ beta
        if int(np.argmax(u)) == int(y[i]):
            hits += 1
    hit_rate = hits / n_races

    # Normalize weights to sum to 1 for the "report-card" weight (for display);
    # keep the raw fitted coefficients separately for actual scoring.
    abs_sum = float(np.sum(np.abs(beta)))
    weights_normalized = (beta / abs_sum).tolist() if abs_sum > 0 else beta.tolist()

    payload = {
        'schema_version': 1,
        'engine_version': 'v2',
        'method': 'conditional_logit',
        'features': FEATURES,
        'subscore_scale': SUBSCORE_SCALE,
        'beta': beta.tolist(),
        'beta_se': [float(x) for x in se],
        'weights_normalized': weights_normalized,
        'l2': args.l2,
        'n_races': n_races,
        'date_range': date_range,
        'fit_diagnostics': {
            'converged': bool(res.success),
            'message': str(res.message),
            'iterations': int(res.nit) if hasattr(res, 'nit') else None,
            'neg_log_lik': nll_at_min,
            'neg_log_lik_null': nll_null,
            'pseudo_r2_mcfadden': pseudo_r2,
            'top1_hit_rate': hit_rate,
        },
        'status': 'insufficient' if insufficient else 'fitted',
        'min_races_required': args.min_races,
        'trained_at': dt.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open('w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write('\n')

    print(f'[fit] wrote {out_path}', file=sys.stderr)
    print(f'[fit] beta = {[f"{x:.4f}" for x in beta.tolist()]}', file=sys.stderr)
    print(f'[fit] se   = {[f"{x:.4f}" for x in se.tolist()]}', file=sys.stderr)
    print(f'[fit] McFadden pseudo-R² = {pseudo_r2:.4f}', file=sys.stderr)
    print(f'[fit] top-1 hit rate     = {hit_rate:.4f}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
