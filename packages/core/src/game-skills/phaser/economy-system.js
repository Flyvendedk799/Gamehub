// when_to_use: Currency, resources, and shop system — reach for this when the
// game has coins/gold/energy to earn and spend, an item catalog, or upgrades
// with scaling costs (tower-defense, tycoon, idle, roguelike shops). The wallet
// is the source of truth for balance; the catalog defines purchasable items with
// fixed or dynamic costs; upgrades use an exponential scaling formula so the
// cost of repeated purchases rises predictably. All state is plain JS so it can
// be serialised with save-state.js. Capability tag: hasEconomy.

/**
 * Create a wallet that tracks a single currency.
 *
 * config:
 *   initial   starting balance (default 0)
 *   max       cap on balance (default Number.POSITIVE_INFINITY)
 *   onChange  optional callback(newBalance, delta) — hook for HUD updates
 */
export function createWallet(config = {}) {
  let balance = config.initial ?? 0;
  const max = config.max ?? Number.POSITIVE_INFINITY;

  function _emit(delta) {
    config.onChange?.(balance, delta);
  }

  return {
    get balance() {
      return balance;
    },

    /** Add `amount` to the wallet (clamps to max). Returns new balance. */
    earn(amount) {
      const delta = Math.min(amount, max - balance);
      balance += delta;
      _emit(delta);
      return balance;
    },

    /** Deduct `amount`. Returns true on success, false if insufficient funds. */
    spend(amount) {
      if (balance < amount) return false;
      balance -= amount;
      _emit(-amount);
      return true;
    },

    /** Non-destructive affordability check. */
    canAfford(amount) {
      return balance >= amount;
    },

    /** Set balance directly (for loading from save). */
    set(amount) {
      const prev = balance;
      balance = Math.min(Math.max(0, amount), max);
      _emit(balance - prev);
    },

    /** Serialisable snapshot. */
    toJSON() {
      return { balance };
    },
  };
}

/**
 * Create an item catalog with purchase logic.
 *
 * items: Array of { id, label, cost, description?, maxOwned? }
 *   maxOwned: how many the player can own (default 1 for gear, Number.POSITIVE_INFINITY for consumables)
 *
 * Returns { buy(id, wallet), canBuy(id, wallet), getItem(id), owned, reset }.
 */
export function createCatalog(items = []) {
  const catalog = new Map(items.map((item) => [item.id, { ...item }]));
  // owned: {id -> count}
  const owned = new Map(items.map((item) => [item.id, 0]));

  return {
    /** Attempt to purchase item `id` using `wallet`. Returns {ok, reason}. */
    buy(id, wallet) {
      const item = catalog.get(id);
      if (!item) return { ok: false, reason: 'unknown_item' };
      const max = item.maxOwned ?? 1;
      const count = owned.get(id) ?? 0;
      if (count >= max) return { ok: false, reason: 'max_owned' };
      if (!wallet.canAfford(item.cost)) return { ok: false, reason: 'insufficient_funds' };
      wallet.spend(item.cost);
      owned.set(id, count + 1);
      return { ok: true, item };
    },

    /** Non-destructive check. */
    canBuy(id, wallet) {
      const item = catalog.get(id);
      if (!item) return false;
      const max = item.maxOwned ?? 1;
      if ((owned.get(id) ?? 0) >= max) return false;
      return wallet.canAfford(item.cost);
    },

    getItem(id) {
      return catalog.get(id);
    },

    /** How many of `id` the player currently owns. */
    ownedCount(id) {
      return owned.get(id) ?? 0;
    },

    /** All items as an array (for rendering a shop UI). */
    allItems() {
      return [...catalog.values()];
    },

    /** Serialisable snapshot of owned counts. */
    toJSON() {
      return Object.fromEntries(owned);
    },

    /** Restore owned counts from a saved snapshot. */
    fromJSON(data) {
      for (const [id, count] of Object.entries(data ?? {})) {
        if (owned.has(id)) owned.set(id, count);
      }
    },

    reset() {
      for (const id of owned.keys()) owned.set(id, 0);
    },
  };
}

/**
 * Upgrade helper with exponentially scaling costs.
 *
 * upgrades: Array of { id, label, baseCost, costScale, maxLevel, value(level) }
 *   baseCost:  cost at level 1
 *   costScale: multiplier per level (default 1.5 → cost * 1.5^level)
 *   maxLevel:  cap (default Number.POSITIVE_INFINITY)
 *   value(lvl) -> computed stat at `lvl` — e.g. (l) => 100 + l * 20
 *
 * Returns { upgrade(id, wallet), costAt(id), valueAt(id), levelOf(id), toJSON, fromJSON }.
 */
export function createUpgradeSystem(upgrades = []) {
  const defs = new Map(upgrades.map((u) => [u.id, u]));
  const levels = new Map(upgrades.map((u) => [u.id, 0]));

  function costAt(id) {
    const def = defs.get(id);
    if (!def) return Number.POSITIVE_INFINITY;
    const lvl = levels.get(id) ?? 0;
    const scale = def.costScale ?? 1.5;
    return Math.round(def.baseCost * scale ** lvl);
  }

  function valueAt(id) {
    const def = defs.get(id);
    if (!def) return 0;
    const lvl = levels.get(id) ?? 0;
    return typeof def.value === 'function' ? def.value(lvl) : lvl;
  }

  return {
    /** Attempt to buy the next level of upgrade `id`. Returns {ok, newLevel, newValue}. */
    upgrade(id, wallet) {
      const def = defs.get(id);
      if (!def) return { ok: false, reason: 'unknown_upgrade' };
      const lvl = levels.get(id) ?? 0;
      const max = def.maxLevel ?? Number.POSITIVE_INFINITY;
      if (lvl >= max) return { ok: false, reason: 'max_level' };
      const cost = costAt(id);
      if (!wallet.canAfford(cost)) return { ok: false, reason: 'insufficient_funds' };
      wallet.spend(cost);
      const newLevel = lvl + 1;
      levels.set(id, newLevel);
      return { ok: true, newLevel, newValue: valueAt(id), nextCost: costAt(id) };
    },

    costAt,
    valueAt,
    levelOf(id) {
      return levels.get(id) ?? 0;
    },
    allUpgrades() {
      return [...defs.values()];
    },
    toJSON() {
      return Object.fromEntries(levels);
    },
    fromJSON(data) {
      for (const [id, lvl] of Object.entries(data ?? {})) {
        if (levels.has(id)) levels.set(id, lvl);
      }
    },
    reset() {
      for (const id of levels.keys()) levels.set(id, 0);
    },
  };
}

// Usage:
//   import { createWallet, createCatalog, createUpgradeSystem } from './engine/economy-system.js';
//   // create():
//   this.wallet = createWallet({ initial: 50, onChange: (bal) => this.hud.setCoins(bal) });
//   this.shop = createCatalog([
//     { id: 'shield',  label: 'Shield',   cost: 30 },
//     { id: 'potion',  label: 'Potion',   cost: 10, maxOwned: Number.POSITIVE_INFINITY },
//   ]);
//   this.upgrades = createUpgradeSystem([
//     { id: 'speed', label: 'Speed', baseCost: 25, costScale: 1.6, maxLevel: 5,
//       value: (lvl) => 120 + lvl * 30 },
//     { id: 'damage', label: 'Damage', baseCost: 20, costScale: 1.8, maxLevel: 8,
//       value: (lvl) => 10 + lvl * 5 },
//   ]);
//   // On enemy death: this.wallet.earn(enemySpec.reward);
//   // Shop button: const result = this.shop.buy('shield', this.wallet); if (result.ok) applyShield();
//   // Upgrade btn:  const r = this.upgrades.upgrade('speed', this.wallet); this.player.speed = r.newValue;
//
//   //   window.__game.debug.snapshot = () => ({
//   //     balance: this.wallet.balance,
//   //     owned: this.shop.toJSON(),
//   //     upgrades: this.upgrades.toJSON(),
//   //   });
