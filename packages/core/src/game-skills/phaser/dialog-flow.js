// when_to_use: Dialogue / narrative runner for Phaser scenes — reach for this
// when the game has story beats, NPC conversations, tutorial prompts, or any
// text that needs to be revealed word-by-word and possibly branch on player
// choices. Feed it a node graph of {id, text, speaker, choices} objects;
// call runner.start(nodeId) to begin; the system renders into a Phaser
// Graphics+Text box, typewriters each line, then waits for click/tap or
// shows choice buttons. onEnd fires when the graph reaches a terminal node.
// Capability tag: hasNarrative.

import * as Phaser from 'phaser';

const DEFAULTS = {
  boxX: 20,
  boxY: 400,
  boxW: 740,
  boxH: 140,
  padding: 16,
  fillColor: 0x1a1a2e,
  fillAlpha: 0.92,
  borderColor: 0x7b61ff,
  fontSize: '16px',
  fontFamily: 'monospace',
  typespeedMs: 28, // ms per character
  depth: 100,
};

/**
 * Create a dialog-flow runner.
 *
 * nodes: Array of node objects:
 *   { id, text, speaker?, choices?: [{label, next}], next? }
 *   - `next` (string id) auto-advances when the player clicks (no choices)
 *   - `choices` renders clickable option buttons; each points to a `next` id
 *   - omit both `next` and `choices` to end the dialog
 *
 * config: overrides for DEFAULTS + onEnd callback.
 *
 * Returns { start(nodeId), hide(), isOpen }.
 */
export function createDialogFlow(scene, nodes = [], config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // --- UI elements (created once, shown/hidden) ---
  const depth = cfg.depth;
  const box = scene.add.graphics().setDepth(depth).setVisible(false);
  const nameText = scene.add
    .text(cfg.boxX + cfg.padding, cfg.boxY + cfg.padding, '', {
      fontSize: '13px',
      fontFamily: cfg.fontFamily,
      color: '#a78bfa',
      fontStyle: 'bold',
    })
    .setDepth(depth + 1)
    .setVisible(false);
  const bodyText = scene.add
    .text(cfg.boxX + cfg.padding, cfg.boxY + cfg.padding + 22, '', {
      fontSize: cfg.fontSize,
      fontFamily: cfg.fontFamily,
      color: '#e8e8f0',
      wordWrap: { width: cfg.boxW - cfg.padding * 2 },
    })
    .setDepth(depth + 1)
    .setVisible(false);

  const choiceButtons = [];
  let typeTimer = null;
  let doneTimer = null;
  let currentNode = null;
  let fullText = '';
  let revealed = '';
  let waitingForInput = false;
  let isOpen = false;
  // Playtest contract: the visual_novel playbook asserts `dialogueIndex` rises
  // on every advance. We track a monotonic line counter (bumped per node shown)
  // + a choice counter so the snapshot exposes the EXACT fields the verdict reads.
  let lineIndex = 0;
  let choicesMade = 0;

  function _drawBox() {
    box.clear();
    box.fillStyle(cfg.fillColor, cfg.fillAlpha);
    box.fillRoundedRect(cfg.boxX, cfg.boxY, cfg.boxW, cfg.boxH, 8);
    box.lineStyle(2, cfg.borderColor, 1);
    box.strokeRoundedRect(cfg.boxX, cfg.boxY, cfg.boxW, cfg.boxH, 8);
  }

  function _clearChoices() {
    for (const btn of choiceButtons) btn.destroy();
    choiceButtons.length = 0;
  }

  function _showChoices(choices) {
    _clearChoices();
    const btnY = cfg.boxY + cfg.boxH + 6;
    const btnW = 160;
    choices.forEach((choice, i) => {
      const bx = cfg.boxX + i * (btnW + 10);
      const bg = scene.add.graphics().setDepth(depth + 2);
      bg.fillStyle(0x3b2f6e, 1);
      bg.fillRoundedRect(bx, btnY, btnW, 34, 6);
      bg.lineStyle(1, cfg.borderColor, 1);
      bg.strokeRoundedRect(bx, btnY, btnW, 34, 6);
      const label = scene.add
        .text(bx + btnW / 2, btnY + 17, choice.label, {
          fontSize: '14px',
          fontFamily: cfg.fontFamily,
          color: '#e8e8f0',
        })
        .setOrigin(0.5)
        .setDepth(depth + 3)
        .setInteractive({ useHandCursor: true });
      label.on('pointerover', () =>
        bg.clear().fillStyle(0x5b4f9e, 1).fillRoundedRect(bx, btnY, btnW, 34, 6),
      );
      label.on('pointerout', () =>
        bg.clear().fillStyle(0x3b2f6e, 1).fillRoundedRect(bx, btnY, btnW, 34, 6),
      );
      label.on('pointerdown', () => {
        choicesMade += 1;
        _gotoNode(choice.next);
      });
      choiceButtons.push(bg, label);
    });
  }

  function _typewrite(text, onDone) {
    typeTimer?.remove(false);
    doneTimer?.remove(false); // cancel any prior node's pending completion
    revealed = '';
    fullText = text;
    let charIdx = 0;
    typeTimer = scene.time.addEvent({
      delay: cfg.typespeedMs,
      repeat: text.length - 1,
      callback: () => {
        revealed += text[charIdx++];
        bodyText.setText(revealed);
      },
      callbackScope: null,
    });
    doneTimer = scene.time.delayedCall(cfg.typespeedMs * text.length + 10, onDone);
  }

  function _gotoNode(nodeId) {
    if (!nodeId) {
      _end();
      return;
    }
    const node = nodeMap.get(nodeId);
    if (!node) {
      _end();
      return;
    }
    _showNode(node);
  }

  function _showNode(node) {
    currentNode = node;
    lineIndex += 1; // monotonic — each shown node advances `dialogueIndex`
    waitingForInput = false;
    _clearChoices();
    _drawBox();
    box.setVisible(true);
    nameText.setText(node.speaker ?? '').setVisible(true);
    bodyText.setText('').setVisible(true);

    _typewrite(node.text, () => {
      if (node.choices?.length) {
        _showChoices(node.choices);
      } else {
        waitingForInput = true;
        // Show a blinking "click to continue" caret.
        bodyText.setText(`${revealed} ▶`);
      }
    });
  }

  function _end() {
    hide();
    config.onEnd?.();
  }

  function hide() {
    typeTimer?.remove(false);
    doneTimer?.remove(false);
    _clearChoices();
    box.setVisible(false);
    nameText.setVisible(false);
    bodyText.setVisible(false);
    isOpen = false;
    currentNode = null;
  }

  // Advance on click when waiting (no choices).
  scene.input.on('pointerdown', () => {
    if (!isOpen || !waitingForInput) return;
    waitingForInput = false;
    _gotoNode(currentNode?.next ?? null);
  });

  return {
    /** Begin the dialog from a given node id. */
    start(nodeId) {
      isOpen = true;
      _gotoNode(nodeId);
    },
    hide,
    get isOpen() {
      return isOpen;
    },
    /** Monotonic line/node counter — the field the visual_novel playbook reads. */
    get lineIndex() {
      return lineIndex;
    },
    /** Number of branching choices the player has taken. */
    get choicesMade() {
      return choicesMade;
    },
    /** Serialisable snapshot — spread into window.__game.debug.track / snapshot.
     *  Exposes the EXACT fields the visual_novel playbook asserts on. */
    snapshot() {
      return { dialogueIndex: lineIndex, choiceCount: choicesMade };
    },
  };
}

// Usage:
//   import { createDialogFlow } from './engine/dialog-flow.js';
//   // create():
//   this.dialog = createDialogFlow(this, [
//     { id: 'intro', speaker: 'Elder', text: 'Young one, the dungeon awaits.', next: 'choice1' },
//     { id: 'choice1', speaker: 'Elder', text: 'Will you accept the quest?',
//       choices: [{ label: 'Yes!', next: 'accept' }, { label: 'Not yet', next: 'decline' }] },
//     { id: 'accept', speaker: 'Elder', text: 'Good luck, hero.' },   // no next = end
//     { id: 'decline', speaker: 'Elder', text: 'Come back when you are ready.' },
//   ], {
//     boxY: 380,
//     onEnd: () => this.physics.resume(),
//   });
//   // Start when the player touches an NPC:
//   this.physics.resume();
//   this.dialog.start('intro');
//
//   // Expose the EXACT fields the visual_novel playbook asserts on. The skill
//   // already tracks a monotonic `lineIndex` + `choicesMade`, so just forward
//   // them — a snapshot of only `isOpen` reports "field missing" → 0/2:
//   //   window.__game.debug.track({
//   //     dialogueIndex: () => this.dialog.lineIndex,
//   //     choiceCount: () => this.dialog.choicesMade,
//   //   });
