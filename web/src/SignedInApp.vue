<script setup lang="ts">
import { SignIn, UserButton, useAuth } from "@clerk/vue";
import HabitsPage from "./HabitsPage.vue";
import CheckeredD from "./CheckeredD.vue";
import type { ApplicationBootstrap } from "./habits";
type Props = { bootstrap: ApplicationBootstrap };
defineProps<Props>();
const { isLoaded, isSignedIn, userId, getToken } = useAuth();
</script>

<template>
  <header v-if="!isLoaded || !isSignedIn" class="app-header">
    <h1 class="brand" aria-label="Damadama">
      <CheckeredD /> <span>Damadama</span>
    </h1>
  </header>
  <main v-if="!isLoaded || !isSignedIn" class="sign-in-content">
    <p v-if="!isLoaded" role="status">Loading sign-in…</p>
    <SignIn v-else-if="!isSignedIn" routing="hash" :with-sign-up="true" />
  </main>
  <HabitsPage
    v-if="isLoaded"
    :account-id="isSignedIn ? (userId ?? null) : null"
    :get-token="() => getToken()"
    :bootstrap="bootstrap"
    ><template #account><UserButton v-if="isSignedIn" /></template
  ></HabitsPage>
</template>
