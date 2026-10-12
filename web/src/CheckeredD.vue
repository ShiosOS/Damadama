<script setup lang="ts">
import { useId } from "vue";
const clipId = `${useId()}-d`;
</script>

<template>
  <svg
    viewBox="0 0 32 32"
    class="brand-mark"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <clipPath :id="clipId">
        <path
          fill-rule="evenodd"
          d="M4 3h12a13 13 0 0 1 0 26H4zm8 6v14h4a7 7 0 0 0 0-14z"
        />
      </clipPath>
    </defs>
    <g :clip-path="`url(#${clipId})`" fill="currentColor">
      <rect width="16" height="16" />
      <rect x="16" y="16" width="16" height="16" />
      <rect x="16" width="16" height="16" fill-opacity="0.42" />
      <rect y="16" width="16" height="16" fill-opacity="0.42" />
    </g>
  </svg>
</template>
