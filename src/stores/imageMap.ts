import type { ImageMap } from '@/services/imageMap';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { readImageMap, writeImageMap } from '@/services/imageMap';
import { useProjectsStore } from './projects';
import { useUIStore } from './ui';

export const useImageMapStore = defineStore('imageMap', () => {
  const projects = useProjectsStore();
  const ui = useUIStore();
  const image = ref<ImageMap | null>(null);
  const loading = ref(false);
  const isImageProject = computed(() => projects.activeProject?.imageMapEnabled === true);
  const active = computed(() => ui.mapProvider === 'image' && image.value !== null);
  const canSearch = computed(() => !isImageProject.value);

  watch(
    () => projects.activeProjectId,
    async (id) => {
      image.value = null;
      if (isImageProject.value) ui.mapProvider = 'image';
      else if (ui.mapProvider === 'image') ui.mapProvider = 'geoportail';
      if (!id) {
        loading.value = false;
        return;
      }
      loading.value = true;
      try {
        const saved = await readImageMap(id);
        if (id !== projects.activeProjectId) return;
        image.value = saved;
        if (saved) {
          ui.mapProvider = 'image';
          // Recover image projects created without the flag by the previous version.
          if (!projects.activeProject?.imageMapEnabled) projects.setImageMapEnabled(true);
        }
      } catch {
        if (id === projects.activeProjectId) image.value = null;
      } finally {
        if (id === projects.activeProjectId) loading.value = false;
      }
    },
    { immediate: true }
  );

  async function apply(value: ImageMap) {
    const id = projects.activeProjectId;
    if (!isImageProject.value) throw new Error('Not an image project');
    if (!id) throw new Error('No active project');
    await writeImageMap(id, value);
    if (id !== projects.activeProjectId) throw new Error('Project changed');
    projects.setImageMapEnabled(true);
    image.value = value;
    ui.mapProvider = 'image';
  }

  return { image, isImageProject, active, canSearch, loading, apply };
});
