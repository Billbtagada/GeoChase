<template>
  <div :aria-label="$t('history.title')" class="history-controls" role="group">
    <v-btn
      :aria-label="$t('history.undo')"
      data-testid="undo-btn"
      :disabled="!history.canUndo"
      icon="mdi-undo"
      size="small"
      :title="$t('history.undoHint', { count: history.undoCount })"
      variant="text"
      @click="history.undo()"
    />

    <v-btn
      :aria-label="$t('history.redo')"
      data-testid="redo-btn"
      :disabled="!history.canRedo"
      icon="mdi-redo"
      size="small"
      :title="$t('history.redoHint', { count: history.redoCount })"
      variant="text"
      @click="history.redo()"
    />
  </div>
</template>

<script setup lang="ts">
import { useHistoryStore } from '@/stores/history';

const history = useHistoryStore();
</script>

<style scoped>
.history-controls {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
</style>
