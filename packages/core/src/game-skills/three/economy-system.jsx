// when_to_use: In-game economy — wallet, item catalog, purchases, and upgrade
// chains with scaling costs. Engine-agnostic: no Three.js dependency. Reach for
// this when a game needs a currency loop: earn coins by playing, spend them in
// a shop, upgrade weapons/stats, repeat. The catalog drives both the shop UI
// data and the canAfford guard. Upgrade costs scale with a configurable formula
// so early levels feel cheap and late levels feel earned. Fires onEarn/onSpend/
// onPurchase/onUpgrade callbacks so the HUD and audio system can react without
// polling. getState() is the single source of truth for rendering the shop.

/** Create an economy controller.
 *
 *  catalog: {
 *    [itemId]: {
 *      label: string,
 *      price: number,            // base purchase price (coins)
 *      description?: string,
 *      maxLevel?: number,        // for upgradeable items (default 1 = not upgradeable)
 *      upgradeBase?: number,     // cost of level-2 upgrade (default price * 1.5)
 *      upgradeScale?: number,    // cost multiplier per level (default 1.8)
 *      onPurchase?(item, state)  // side-effect (e.g. unlock ability)
 *      onUpgrade?(item, newLevel, state)
 *    }
 *  }
 *  opts:
 *    startCoins    -> starting wallet balance (default 0)
 *    onEarn(amount, total)
 *    onSpend(amount, total, itemId)
 *    onPurchase(itemId, item)
 *    onUpgrade(itemId, newLevel)
 *    onInsufficientFunds(itemId, shortfall)
 */
export function createEconomySystem(catalog, opts = {}) {
  let coins = opts.startCoins ?? 0;

  // owned: Map<itemId, { level: number }>
  const owned = new Map();

  // ---------------------------------------------------------------------------
  // Wallet.
  // ---------------------------------------------------------------------------

  /** Award `amount` coins (must be > 0). */
  function earn(amount) {
    if (amount <= 0) return;
    coins += amount;
    opts.onEarn?.(amount, coins);
  }

  /** Deduct `amount` coins. Returns true on success, false if insufficient. */
  function spend(amount, itemId = null) {
    if (amount > coins) return false;
    coins -= amount;
    opts.onSpend?.(amount, coins, itemId);
    return true;
  }

  /** Read current balance. */
  function getCoins() {
    return coins;
  }

  /** True if the wallet can cover `amount`. */
  function canAfford(amount) {
    return coins >= amount;
  }

  // ---------------------------------------------------------------------------
  // Catalog helpers.
  // ---------------------------------------------------------------------------

  function getEntry(itemId) {
    const entry = catalog[itemId];
    if (!entry) throw new Error(`economy-system: unknown item '${itemId}'`);
    return entry;
  }

  /** Price to buy (first acquisition). */
  function buyPrice(itemId) {
    return getEntry(itemId).price;
  }

  /** Price to upgrade `itemId` to its next level. Returns null if max'd out
   *  or not yet owned. */
  function upgradePrice(itemId) {
    const entry = getEntry(itemId);
    const current = owned.get(itemId);
    if (!current) return null; // not owned yet
    const maxLevel = entry.maxLevel ?? 1;
    if (current.level >= maxLevel) return null; // already max
    const base = entry.upgradeBase ?? entry.price * 1.5;
    const scale = entry.upgradeScale ?? 1.8;
    // Cost for level N → N+1:  base * scale^(N-1)
    return Math.round(base * scale ** (current.level - 1));
  }

  /** True if itemId is in the owned set. */
  function isOwned(itemId) {
    return owned.has(itemId);
  }

  /** Current upgrade level (1 = base purchase, 0 = not owned). */
  function getLevel(itemId) {
    return owned.get(itemId)?.level ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Transactions.
  // ---------------------------------------------------------------------------

  /** Attempt to buy itemId. Returns { ok, reason? }. */
  function purchase(itemId) {
    const entry = getEntry(itemId);
    if (isOwned(itemId)) return { ok: false, reason: 'already_owned' };
    const price = entry.price;
    if (!canAfford(price)) {
      opts.onInsufficientFunds?.(itemId, price - coins);
      return { ok: false, reason: 'insufficient_funds', shortfall: price - coins };
    }
    spend(price, itemId);
    owned.set(itemId, { level: 1 });
    entry.onPurchase?.(entry, getState());
    opts.onPurchase?.(itemId, entry);
    return { ok: true };
  }

  /** Attempt to upgrade an already-owned itemId. Returns { ok, reason?, newLevel? }. */
  function upgrade(itemId) {
    const entry = getEntry(itemId);
    if (!isOwned(itemId)) return { ok: false, reason: 'not_owned' };
    const cost = upgradePrice(itemId);
    if (cost === null) return { ok: false, reason: 'max_level' };
    if (!canAfford(cost)) {
      opts.onInsufficientFunds?.(itemId, cost - coins);
      return { ok: false, reason: 'insufficient_funds', shortfall: cost - coins };
    }
    spend(cost, itemId);
    const current = owned.get(itemId);
    current.level += 1;
    entry.onUpgrade?.(entry, current.level, getState());
    opts.onUpgrade?.(itemId, current.level);
    return { ok: true, newLevel: current.level };
  }

  // ---------------------------------------------------------------------------
  // Shop listing — returns catalog enriched with affordability + ownership.
  // ---------------------------------------------------------------------------

  /** Full catalog list for shop UI rendering. */
  function getShopItems() {
    return Object.entries(catalog).map(([id, entry]) => {
      const level = getLevel(id);
      const isOwnedFlag = isOwned(id);
      const upCost = isOwnedFlag ? upgradePrice(id) : null;
      return {
        id,
        label: entry.label,
        description: entry.description ?? '',
        price: entry.price,
        canBuy: !isOwnedFlag && canAfford(entry.price),
        owned: isOwnedFlag,
        level,
        maxLevel: entry.maxLevel ?? 1,
        upgradePrice: upCost,
        canUpgrade: upCost !== null && canAfford(upCost),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // State snapshot.
  // ---------------------------------------------------------------------------

  function getState() {
    return {
      coins,
      owned: Object.fromEntries([...owned.entries()].map(([id, v]) => [id, v.level])),
    };
  }

  /** Restore state from a saved snapshot (e.g. after save.load()). */
  function setState(snapshot) {
    coins = snapshot.coins ?? 0;
    owned.clear();
    for (const [id, level] of Object.entries(snapshot.owned ?? {})) {
      owned.set(id, { level });
    }
  }

  return {
    earn,
    spend,
    getCoins,
    canAfford,
    purchase,
    upgrade,
    isOwned,
    getLevel,
    buyPrice,
    upgradePrice,
    getShopItems,
    getState,
    setState,
  };
}

// Usage:
//   import { createEconomySystem } from './economy-system.jsx';
//
//   const economy = createEconomySystem({
//     double_shot: {
//       label: 'Double Shot',
//       price: 100,
//       description: 'Fire two bullets at once',
//       maxLevel: 1,
//       onPurchase: () => { player.doubleShot = true; },
//     },
//     speed_boost: {
//       label: 'Speed Boost',
//       price: 60,
//       description: 'Move faster each level',
//       maxLevel: 5,
//       upgradeBase: 80,
//       upgradeScale: 1.6,
//       onUpgrade: (_, lv) => { player.speed = 4 + lv * 1.5; },
//     },
//   }, {
//     startCoins: 0,
//     onEarn:   (amt, total) => hud.setCoins(total),
//     onSpend:  (amt, total) => hud.setCoins(total),
//     onPurchase: (id)       => sfx.play('buy'),
//     onUpgrade:  (id, lv)   => sfx.play('upgrade'),
//     onInsufficientFunds: (id, short) => hud.flash(`Need ${short} more coins!`),
//   });
//
//   // On enemy death:
//   economy.earn(25);
//
//   // Shop button click:
//   const result = economy.purchase('double_shot');
//   if (!result.ok) showError(result.reason);
//
//   // Upgrade:
//   economy.upgrade('speed_boost');
//
//   // Render shop:
//   const items = economy.getShopItems();
//
//   window.__game.debug.snapshot = () => economy.getState();
//   // => { coins: 175, owned: { speed_boost: 2 } }
//
// IDLE / INCREMENTAL games — the `idle` playbook asserts the EXACT field
// `credits` (rises on click) and reads `rate` for escalation. This skill's
// field is `coins`, so FORWARD it under the name the verdict reads and add a
// per-second producer rate (buying a producer raises `rate`; `credits` keeps
// accruing on its own):
//   // each frame: economy.earn(perSecond * dt);   // passive accrual
//   // click main earner: economy.earn(clickValue);
//   // buy producer: if (economy.purchase('miner')) perSecond += 1;
//   window.__game.debug.track({
//     credits: () => economy.getCoins(),   // EXACT field name — NOT `coins`/`money`
//     rate:    () => perSecond,             // escalation signal
//   });
