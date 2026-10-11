<script setup lang="ts">
import { SignIn, UserButton, useAuth } from "@clerk/vue";
import HabitsPage from "./HabitsPage.vue";
const { isLoaded, isSignedIn, userId, getToken } = useAuth();
</script>

<template>
  <main class="max-w-3xl mx-auto p-6 space-y-6">
    <header class="flex items-center justify-between">
      <h1 class="text-3xl font-semibold">Damadama</h1>
      <UserButton v-if="isSignedIn" />
    </header>
    <p v-if="!isLoaded" role="status">Loading sign-in…</p>
    <SignIn v-else-if="!isSignedIn" routing="hash" :with-sign-up="true" />
    <HabitsPage
      v-if="isLoaded"
      :account-id="isSignedIn ? (userId ?? null) : null"
      :get-token="() => getToken()"
    />
  </main>
</template>
