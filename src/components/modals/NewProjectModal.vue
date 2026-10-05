<template>
  <FloatingDialog
    blocking
    max-width="600px"
    :model-value="isOpen && !imageSetupOpen"
    :persistent="!projectsStore.activeProject"
    @keydown.esc="closeModal"
    @update:model-value="closeModal"
  >
    <v-card class="new-project-card">
      <v-card-title>{{
        $t(isRegularizing ? 'workspace.regularizeProjectTitle' : 'project.newProject')
      }}</v-card-title>

      <v-card-text>
        <p class="project-intro">
          {{
            $t(
              isRegularizing
                ? 'workspace.regularizeProjectDescription'
                : 'workspace.newProjectDescription'
            )
          }}
        </p>

        <v-form @submit.prevent="submitForm()">
          <v-select
            v-if="recoverySources.length > 1 && !projectsStore.activeProject"
            v-model="selectedRecovery"
            class="mb-4"
            data-testid="recovery-source-select"
            :items="
              recoverySources.map((source, index) => ({
                title: source.name || $t('workspace.recoverySource', { number: index + 1 }),
                value: source.key,
              }))
            "
            :label="$t('workspace.recoverySelection')"
            variant="outlined"
            @update:model-value="restoreSource"
          />

          <v-text-field
            v-model="projectName"
            autofocus
            class="mb-4"
            data-testid="project-name-input"
            density="compact"
            :label="$t('project.projectName')"
            :placeholder="$t('workspace.projectPlaceholder')"
            variant="outlined"
            @keydown.enter.prevent="submitForm()"
          />

          <fieldset v-if="!isRegularizing" class="project-start-options">
            <legend>{{ $t('project.startWith') }}</legend>

            <label
              v-for="option in startOptions"
              :key="option.value"
              class="project-start-option"
              :class="{ 'project-start-option-selected': projectKind === option.value }"
            >
              <input v-model="projectKind" name="project-kind" type="radio" :value="option.value" />
              <v-icon :icon="option.icon" size="30" />

              <span
                ><strong>{{ $t(option.title) }}</strong>

                <small>{{ $t(option.description) }}</small></span
              >

              <v-icon
                v-if="projectKind === option.value"
                color="primary"
                icon="mdi-check-circle"
                size="20"
              />
            </label>
          </fieldset>

          <ProjectionSelect v-if="projectKind === 'map' || isRegularizing" v-model="projection" />
          <p v-else class="project-image-next">{{ $t('project.imageNext') }}</p>
        </v-form>
      </v-card-text>

      <v-card-actions>
        <v-btn v-if="projectsStore.activeProject" variant="text" @click="closeModal">{{
          $t('common.cancel')
        }}</v-btn>

        <v-spacer />

        <v-btn
          color="primary"
          data-testid="create-project-btn"
          :disabled="!projectName.trim() || needsRecoverySelection"
          @click="submitForm()"
        >
          {{
            $t(
              isRegularizing
                ? 'project.saveProject'
                : projectKind === 'image'
                  ? 'project.chooseImage'
                  : 'workspace.createProject'
            )
          }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </FloatingDialog>

  <ImageMapModal v-if="imageSetupOpen" creation :save-image="submitForm" @close="closeImageSetup" />
</template>

<script lang="ts" setup>
import type { ImageMap } from '@/services/imageMap';
import type { RecoverySource } from '@/services/projectRecovery';
import type { ProjectProjection } from '@/types/project';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ImageMapModal from '@/components/modals/ImageMapModal.vue';
import FloatingDialog from '@/components/shared/FloatingDialog.vue';
import ProjectionSelect from '@/components/shared/ProjectionSelect.vue';
import { useDrawingContext, useMapContext } from '@/composables/mapContext';
import { isLanguageSet } from '@/plugins/i18n';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '@/services/geoportail';
import {
  backupRecoverySources,
  clearUnassignedWork,
  getRecoverySources,
  saveUnassignedWork,
} from '@/services/projectRecovery';
import { useLayersStore } from '@/stores/layers';
import { useProjectsStore } from '@/stores/projects';
import { useUIStore } from '@/stores/ui';

const uiStore = useUIStore();
const layersStore = useLayersStore();
const projectsStore = useProjectsStore();
const mapContainer = useMapContext();
const drawing = useDrawingContext();
const { t } = useI18n();

const imageSetupOpen = ref(false);
const projectKind = ref<'map' | 'image'>('map');
const startOptions = [
  {
    value: 'map',
    icon: 'mdi-map-outline',
    title: 'project.geographicStart',
    description: 'project.geographicStartHint',
  },
  {
    value: 'image',
    icon: 'mdi-image-outline',
    title: 'project.imageStart',
    description: 'project.imageStartHint',
  },
];
function closeImageSetup() {
  imageSetupOpen.value = false;
  uiStore.closeModal('imageMapModal');
}
const projectName = ref('');
const projection = ref<ProjectProjection>('mercator');
const recoverySources = ref<RecoverySource[]>([]);
const selectedRecovery = ref<string | null>(null);
const needsRecoverySelection = computed(
  () => !projectsStore.activeProject && recoverySources.value.length > 1 && !selectedRecovery.value
);
const isRegularizing = computed(
  () => !projectsStore.activeProject && (!layersStore.isEmpty || recoverySources.value.length > 0)
);

function restoreSource(key: string) {
  const source = recoverySources.value.find((item) => item.key === key);
  if (!source) return;
  projection.value = source.projection;
  projectName.value = source.name;
  layersStore.loadLayers(source.data);
  if (mapContainer.map.value) drawing.redrawAllElements();
}

watch(
  () => projectsStore.activeProject,
  (project, previousProject) => {
    if (project) {
      recoverySources.value = [];
      selectedRecovery.value = null;
      return;
    }
    // Deliberate deletion is handled by the project manager, not recovery.
    if (previousProject || uiStore.isModalOpen('loadProjectModal')) return;
    // Live work takes priority over older snapshots or stored projects.
    if (!layersStore.isEmpty) return;
    recoverySources.value = getRecoverySources();
    if (recoverySources.value.length === 1) {
      selectedRecovery.value = recoverySources.value[0]!.key;
      restoreSource(selectedRecovery.value);
    }
  },
  { immediate: true }
);

watch(
  () => mapContainer.map.value,
  (map) => {
    if (map && !projectsStore.activeProject && !layersStore.isEmpty) drawing.redrawAllElements();
  }
);

watch(
  // Assigned projects use their own autosave. Do not deeply traverse their layers
  // synchronously for every reference normalized while loading a large project.
  () => (projectsStore.activeProject ? null : [layersStore.exportLayers(), projection.value]),
  () => {
    if (
      projectsStore.activeProject ||
      layersStore.isEmpty ||
      uiStore.isModalOpen('loadProjectModal')
    )
      return;
    try {
      saveUnassignedWork(layersStore.exportLayers(), projection.value);
    } catch {
      uiStore.addToast(t('project.errors.saveFailed'), 'error');
    }
  },
  { deep: true, immediate: true, flush: 'sync' }
);

const isOpen = computed({
  get: () =>
    uiStore.isModalOpen('newProjectModal') ||
    (!projectsStore.activeProject &&
      !uiStore.isModalOpen('languageModal') &&
      !uiStore.isModalOpen('loadProjectModal') &&
      isLanguageSet()),
  set: (value) => {
    if (!value) {
      closeModal();
    }
  },
});

watch(isOpen, (open) => {
  if (!open) {
    projectName.value = '';
    projection.value = 'mercator';
    projectKind.value = 'map';
    closeImageSetup();
  }
});

async function submitForm(image?: ImageMap) {
  const name = projectName.value.trim();
  if (needsRecoverySelection.value) return;
  if (!name) {
    uiStore.addToast(t('project.errors.invalidName'), 'error');
    return;
  }

  if (projectKind.value === 'image' && !isRegularizing.value && !image) {
    imageSetupOpen.value = true;
    uiStore.openModal('imageMapModal');
    return;
  }

  // Capture orphaned work before changing the active project. Persist it first;
  // a storage failure must leave the drawings and the required dialog intact.
  const preserveDrawings = !projectsStore.activeProject;
  const leavingImage = projectsStore.activeProject?.imageMapEnabled && !image;
  const data = layersStore.exportLayers();
  try {
    if (preserveDrawings) backupRecoverySources();
    else projectsStore.autoSaveActiveProject(data);
    if (image && !isRegularizing.value) await projectsStore.createImageProject(name, image);
    else
      projectsStore.createAndSwitchProject(
        name,
        projection.value,
        preserveDrawings ? data : undefined
      );
    if (!preserveDrawings) {
      layersStore.clearLayers();
      mapContainer.clearLayers();
      if (leavingImage)
        mapContainer.setCenter(DEFAULT_MAP_CENTER.lat, DEFAULT_MAP_CENTER.lon, DEFAULT_MAP_ZOOM);
    }
    // Clear the temporary copy only once the complete project is durable.
    if (preserveDrawings) clearUnassignedWork();
    recoverySources.value = [];
    selectedRecovery.value = null;
    uiStore.addToast(t('project.created'), 'success');
    closeModal();
    projectName.value = '';
  } catch (error) {
    uiStore.addToast(t('project.errors.saveFailed'), 'error');
    if (image) throw error;
  }
}

function closeModal() {
  if (!projectsStore.activeProject) return;
  uiStore.closeModal('newProjectModal');
}
</script>

<style scoped>
.project-start-options {
  border: 0;
  padding: 0;
  margin: 0 0 24px;
  display: grid;
  gap: 10px;
}
.project-start-options legend {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
}
.project-start-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--gc-border);
  border-radius: 10px;
  cursor: pointer;
}
.project-start-option-selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.06);
}
.project-start-option:has(input:focus-visible) {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 3px;
}
.project-start-option input:focus-visible {
  outline: none;
}
.project-start-option input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}
.project-start-option span {
  flex: 1;
}
.project-start-option strong,
.project-start-option small {
  display: block;
}
.project-start-option small {
  color: var(--gc-muted);
  font-size: 13px;
  line-height: 1.5;
  margin-top: 4px;
}
.project-image-next {
  font-size: 14px;
  color: var(--gc-muted);
  line-height: 1.6;
  margin: 0;
}
.new-project-card > .v-card-title {
  padding: 24px 24px 8px;
}
.project-intro {
  color: var(--gc-muted);
  font-size: 14px;
  line-height: 1.65;
  margin-bottom: 24px;
}
</style>
