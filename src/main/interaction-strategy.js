'use strict';
const { readRecords } = require('./memory-evidence');
const { rank, canRead } = require('./memory-scope');

// Only WorkBuddy currently has an app-specific fast path. Unknown targets and
// WeChat always use the visual controller; a failure is sticky until cleared
// by forgetting its source rather than retried on every task.
class InteractionStrategy {
  constructor(memory, getScene = () => 'life') { Object.assign(this, { memory, getScene }); }
  async preferVisual(task) {
    if (task.target !== 'workbuddy') return true;
    const rows = (await this.memory.query('task', 200, { scene: this.getScene(), sort: 'ingestion', requiredMarkers: ['bunny_interaction_failed_anchor'] }))
      .filter(r => r.state === 'active' && canRead(this.getScene(), r) && r.value.schema === 'interaction-strategy/v1' && r.value.application === task.target);
    return rows.some(r => r.value.outcome === 'failed');
  }
  async record(task, outcome) {
    if (!this.memory.ready || !task.id || !['failed', 'success'].includes(outcome)) return;
    const source = (await readRecords(this.memory, [task.id], { scene: this.getScene() }))[0];
    if (!source || source.state !== 'active') return;
    await this.memory.write([{ id: 'interaction-strategy:' + task.id, kind: 'task', ts: Date.now(), domain: task.domain || 'work', visibilityFloor: Math.max(rank(task.scene || 'work'), task.visibilityFloor || 0),
      value: { schema: 'interaction-strategy/v1', taskType: 'interaction-strategy', application: task.target, strategy: 'ui-controls', outcome, sources: [task.id] } }]);
  }
}
module.exports = { InteractionStrategy };
