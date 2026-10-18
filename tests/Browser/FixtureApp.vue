<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { z } from "zod";
import { readApplication } from "../../web/src/habits";
import HabitsPage from "../../web/src/HabitsPage.vue";

const fixtureData: unknown = await (await fetch("/fixture.json")).json();
const fixture = z
  .object({ tokens: z.record(z.string(), z.string()), bootstrap: z.unknown() })
  .parse(fixtureData);
const tokens = fixture.tokens;
const bootstrap = readApplication(fixture.bootstrap);
const account = ref<string | null>(
  new URLSearchParams(location.search).get("account") ?? "owner",
);
const getToken = async (): Promise<string | null> =>
  account.value ? (tokens[account.value] ?? null) : null;
const otherAccount = (): void => {
  account.value = "other";
};
const signOut = (): void => {
  account.value = null;
};
onMounted(() => {
  window.addEventListener("fixture:other-account", otherAccount);
  window.addEventListener("fixture:sign-out", signOut);
});
onUnmounted(() => {
  window.removeEventListener("fixture:other-account", otherAccount);
  window.removeEventListener("fixture:sign-out", signOut);
});
</script>

<template>
  <UApp>
    <nav class="fixture-controls" aria-label="Test fixture account controls">
      <button @click="account = null">Fixture sign out</button>
      <button @click="account = 'other'">Fixture other account</button>
      <button @click="account = 'owner'">Fixture owning account</button>
    </nav>
    <Suspense
      ><HabitsPage
        :account-id="account"
        :get-token="getToken"
        :bootstrap="bootstrap"
    /></Suspense>
  </UApp>
</template>

<style scoped>
.fixture-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 24px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 0.75rem;
}
</style>
