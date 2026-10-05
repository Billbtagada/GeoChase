<template>
  <v-dialog v-model="isOpen" max-width="800px">
    <v-card>
      <v-card-title class="d-flex justify-space-between align-center">
        <span>{{ $t('ignLegend.title') }}</span>
        <v-btn icon="mdi-close" variant="text" @click="isOpen = false"></v-btn>
      </v-card-title>

      <v-divider></v-divider>

      <!-- Conteneur avec défilement pour explorer toute la feuille -->
      <v-card-text class="legend-container text-center pa-4">
        <v-img
          alt="Feuille de légende IGN"
          class="legend-image"
          contain
          src="/images/legende-ign.png"
        />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const isOpen = ref(false);

function open() {
  isOpen.value = true;
}

defineExpose({ open });
</script>

<style scoped>
.legend-container {
  max-height: 75vh;
  overflow-y: auto;
  background-color: #f5f5f5;
}

.legend-image {
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}
</style>
