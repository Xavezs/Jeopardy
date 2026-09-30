import React, { useState, useEffect, useCallback } from 'react';
import '../styles/player.css';
import { createPortal } from 'react-dom';
import { fetchCatalog, buyItem, equipItem } from '../lib/api/shop';
import '../styles/skill.css';
import { getSharedAudioCtx, withRunningCtx } from '../lib/sfx';
import DomainExpansion from './DomainExpansion';

/* =========================================================================
   ShopModal
   Cosmetics shop + loadout manager for players. Opens from the room bar
   in PlayerView. Two tabs:
     Shop    — browse and buy items with earned coins
     Loadout — equip / unequip owned items

   Custom buzz sounds are previewed here using the same synth-or-file
   pattern as boardSfx.js — no extra infrastructure needed.
   ========================================================================= */

// ── Synth preview for items that have synthParams ─────────────────────────
function playSynthPreview(params) {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
      const t0 = ctx.currentTime;
      const { type = 'square', startHz = 220, endHz = 440, durationMs = 200, volume = 0.2 } = params;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(startHz, t0);
      osc.frequency.linearRampToValueAtTime(endHz, t0 + durationMs / 1000);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start(t0);
      osc.stop(t0 + durationMs / 1000 + 0.05);
    });
  } catch (_) { /* best effort */ }
}

function previewItem(item) {
  if (!item?.data) return;
  if (item.data.synth && item.data.synthParams) {
    playSynthPreview(item.data.synthParams);
    return;
  }
  if (item.data.asset) {
    try {
      const audio = new Audio(`/api/shop/sfx/${item.data.asset}`);
      audio.volume = 0.3;
      audio.play().catch(() => {});
    } catch (_) { /* best effort */ }
  }
}

// ── Single item card ───────────────────────────────────────────────────────
function ItemCard({ item, coins, onBuy, onEquip, onUnequip, buying, equipping, onPreviewSkill }) {
  const canAfford = coins >= item.price;
  const statusLabel = item.equipped ? 'Equipped' : item.owned ? 'Owned' : null;
  const isSkill = item.type === 'skill';

  return (
    <div className={'shop-item-card' + (item.equipped ? ' is-equipped' : '') + (item.owned ? ' is-owned' : '') + (isSkill ? ' is-skill' : '')}>
      <div className="shop-item-header">
        <span className="shop-item-name">{item.name}</span>
        {statusLabel && <span className="shop-item-status">{statusLabel}</span>}
        {isSkill && <span className="shop-item-type-badge">Skill</span>}
      </div>
      <p className="shop-item-desc">{item.description}</p>
      <div className="shop-item-footer">
        <button
          type="button"
          className="shop-preview-btn"
          onClick={() => isSkill ? onPreviewSkill?.(item) : previewItem(item)}
          title={isSkill ? 'Preview skill animation' : 'Preview sound'}
        >
          Preview
        </button>
        {!item.owned ? (
          <button
            type="button"
            className={'shop-buy-btn' + (!canAfford ? ' disabled' : '')}
            disabled={!canAfford || buying}
            onClick={() => onBuy(item)}
            title={!canAfford ? `Need ${item.price - coins} more coins` : `Buy for ${item.price} coins`}
          >
            {buying ? '…' : `${item.price} coins`}
          </button>
        ) : item.equipped ? (
          <button type="button" className="shop-unequip-btn" disabled={equipping} onClick={() => onUnequip(item)}>
            {equipping ? '…' : 'Unequip'}
          </button>
        ) : (
          <button type="button" className="shop-equip-btn" disabled={equipping} onClick={() => onEquip(item)}>
            {equipping ? '…' : 'Equip'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────
export default function ShopModal({ onClose, discordUserId, onChanged }) {
  const [tab, setTab] = useState('buzzer'); // 'buzzer' | 'power' | 'inventory'
  const [catalog, setCatalog] = useState(null);
  const [coins, setCoins] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null); // itemId currently being bought/equipped
  const [previewSkill, setPreviewSkill] = useState(null); // item being previewed as skill

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCatalog();
      setCatalog(data.items);
      setCoins(data.coins);
    } catch (e) {
      setError(e.message || 'Failed to load shop');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleBuy(item) {
    setBusyId(item.id);
    try {
      const result = await buyItem(item.id);
      setCoins(result.coins);
      // Skills auto-equip on purchase (server unequips any other skill).
      setCatalog((prev) =>
        prev.map((i) => {
          if (i.id === item.id) return { ...i, owned: true, equipped: !!result.equipped };
          if (result.equipped && i.type === item.type) return { ...i, equipped: false };
          return i;
        })
      );
      onChanged?.();
    } catch (e) {
      alert(e.message || 'Purchase failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleEquip(item) {
    setBusyId(item.id);
    try {
      await equipItem(item.id, true);
      onChanged?.();
      // Unequip all others of same type, equip this one
      setCatalog((prev) =>
        prev.map((i) => {
          if (i.type === item.type) return { ...i, equipped: i.id === item.id };
          return i;
        })
      );
    } catch (e) {
      alert(e.message || 'Equip failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleUnequip(item) {
    setBusyId(item.id);
    try {
      await equipItem(item.id, false);
      onChanged?.();
      setCatalog((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, equipped: false } : i))
      );
    } catch (e) {
      alert(e.message || 'Unequip failed');
    } finally {
      setBusyId(null);
    }
  }

  const buzzerItems    = catalog?.filter((i) => i.type === 'buzz_sound' && !i.owned) ?? [];
  const powerItems     = catalog?.filter((i) => i.type === 'skill' && !i.owned) ?? [];
  const inventoryItems = catalog?.filter((i) => i.owned) ?? [];

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shop-modal">

        {/* Header */}
        <div className="shop-modal-header">
          <div className="shop-modal-title">Shop (WIP)</div>
          <div className="shop-coins-badge">
            <span className="shop-coins-icon">C</span>
            <span className="shop-coins-value">{coins.toLocaleString()}</span>
            <span className="shop-coins-label">coins</span>
          </div>
          <button type="button" className="shop-close-btn" onClick={onClose} aria-label="Close shop">✕</button>
        </div>

        <p className="shop-earn-hint">
          Earn coins by playing — 100 per correct answer, +200 for 1st place, +100 for 2nd.
        </p>

        {/* Tabs */}
        <div className="round-tabs shop-tabs">
          <button
            type="button"
            className={'round-tab' + (tab === 'buzzer' ? ' active' : '')}
            onClick={() => setTab('buzzer')}
          >
            Buzzer
          </button>
          <button
            type="button"
            className={'round-tab' + (tab === 'power' ? ' active' : '')}
            onClick={() => setTab('power')}
          >
            Power
          </button>
          <button
            type="button"
            className={'round-tab' + (tab === 'inventory' ? ' active' : '')}
            onClick={() => setTab('inventory')}
          >
            Inventory
          </button>
        </div>

        {/* Body */}
        {loading && <div className="shop-loading">Loading…</div>}
        {error && <div className="shop-error">{error}</div>}

        {!loading && !error && tab === 'buzzer' && (
          buzzerItems.length === 0
            ? <p className="shop-empty">No buzzer sounds available — check your Inventory.</p>
            : (
              <div className="shop-item-grid">
                {buzzerItems.map((item) => (
                  <ItemCard key={item.id} item={item} coins={coins}
                    onBuy={handleBuy} onEquip={handleEquip} onUnequip={handleUnequip}
                    buying={busyId === item.id} equipping={busyId === item.id}
                    onPreviewSkill={setPreviewSkill}
                  />
                ))}
              </div>
            )
        )}

        {!loading && !error && tab === 'power' && (
          <>
            <p className="power-tab-intro">
              Unlock a power here and it's equipped automatically. In a game, the host spins the Power-ups
              tab of the Randomizer: every player with a power equipped rolls a 10% chance to win it on the
              slot machine, and once won you can use it once per game.
            </p>
            {powerItems.length === 0
              ? <p className="shop-empty">You've unlocked every power. Check your Inventory.</p>
              : (
                <div className="shop-item-grid">
                  {powerItems.map((item) => (
                    <ItemCard key={item.id} item={item} coins={coins}
                      onBuy={handleBuy} onEquip={handleEquip} onUnequip={handleUnequip}
                      buying={busyId === item.id} equipping={busyId === item.id}
                      onPreviewSkill={setPreviewSkill}
                    />
                  ))}
                </div>
              )}
          </>
        )}

        {!loading && !error && tab === 'inventory' && (
          inventoryItems.length === 0
            ? <p className="shop-empty">Nothing owned yet. Buy a buzzer sound, or unlock a power in the Power tab.</p>
            : (
              <div className="shop-item-grid">
                {inventoryItems.map((item) => (
                  <ItemCard key={item.id} item={item} coins={coins}
                    onBuy={handleBuy} onEquip={handleEquip} onUnequip={handleUnequip}
                    buying={busyId === item.id} equipping={busyId === item.id}
                    onPreviewSkill={setPreviewSkill}
                  />
                ))}
              </div>
            )
        )}
      </div>

      {/* Skill preview cutscene — portaled so it escapes the modal's overflow */}
      {previewSkill?.data?.preview === 'domain_expansion' &&
        createPortal(
          <DomainExpansion onDone={() => setPreviewSkill(null)} />,
          document.body
        )
      }
    </div>
  );
}
