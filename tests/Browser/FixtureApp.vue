<script setup lang="ts">
import { ref } from "vue";
import { z } from "zod";
import HabitsPage from "../../web/src/HabitsPage.vue";

const tokens = z
  .record(z.string(), z.string())
  .parse(await (await fetch("/fixture.json")).json());
const account = ref<string | null>(
  new URLSearchParams(location.search).get("account") ?? "owner",
);
const getToken = async () =>
  account.value ? (tokens[account.value] ?? null) : null;
</script>

<template>
  <UApp>
    <main class="max-w-3xl mx-auto p-6 space-y-6">
      <h1 class="text-3xl">Damadama</h1>
      <nav class="flex gap-3" aria-label="Test fixture account controls">
        <button @click="account = null">Fixture sign out</button>
        <button @click="account = 'other'">Fixture other account</button>
        <button @click="account = 'owner'">Fixture owning account</button>
      </nav>
      <Suspense
        ><HabitsPage :account-id="account" :get-token="getToken"
      /></Suspense>
    </main>
  </UApp>
</template>
