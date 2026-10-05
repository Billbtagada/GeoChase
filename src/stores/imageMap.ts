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
      if (!id) {
        loading.value = false;
        if (ui.mapProvider === 'image') ui.mapProvider = 'geoportail';
        return;
      }

      loading.value = true;
      try {
        // On lit d'abord IndexedDB pour voir si une image existe pour ce projet
        const saved = await readImageMap(id);
        if (id !== projects.activeProjectId) return;

        image.value = saved;

        // Si une image sauvegardée existe ou que le projet est marqué comme image, on bascule sur 'image'
        if (saved || projects.activeProject?.imageMapEnabled) {
          ui.mapProvider = 'image';
          if (projects.activeProject && !projects.activeProject.imageMapEnabled) {
            projects.setImageMapEnabled(true);
          }
        } else {
          // Sinon seulement on repasse sur l'IGN si on était en mode image par erreur
          if (ui.mapProvider === 'image') {
            ui.mapProvider = 'geoportail';
          }
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
