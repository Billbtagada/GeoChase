import type { useDrawing } from './useDrawing';
import type { useNoteTooltips } from './useNoteTooltips';
import type { Ref } from 'vue';
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useHistoryStore } from '@/stores/history';

export function useHistory(
  drawing: ReturnType<typeof useDrawing>,
  tooltips: Ref<ReturnType<typeof useNoteTooltips> | null>
) {
  const history = useHistoryStore();

  watch(
    () => history.revision,
    () => {
      tooltips.value?.clearAllTooltips();
      drawing.redrawAllElements({ fitBounds: false });
      tooltips.value?.updateNoteTooltips();
    },
    { flush: 'sync' }
  );

  function handleKeydown(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey)
    )
      return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest(
          'input, textarea, select, [role="textbox"], [role="combobox"], [role="dialog"]'
        ))
    )
      return;
    const key = event.key.toLowerCase();
    const undo = key === 'z' && !event.shiftKey;
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
    if (!undo && !redo) return;
    event.preventDefault();
    if (undo) history.undo();
    else history.redo();
  }

  const saveHistory = () => {
    void history.flush();
  };
  onMounted(() => {
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('pagehide', saveHistory);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeydown);
    window.removeEventListener('pagehide', saveHistory);
    history.stop();
  });
  return history;
}
