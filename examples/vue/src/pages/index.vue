<script setup lang="ts">
import { ref } from 'vue'

const count = ref(0)
</script>

<template>
  <main>
    <h1>Vue multi-page example</h1>
    <button @click="count++">
      Count: {{ count }}
    </button>
    <nav>
      <a href="./hello-world.html">Hello World</a>
      <a href="./admin/users.html">Users</a>
    </nav>
  </main>
</template>

<style scoped>
main { padding: 2rem; font-family: sans-serif; }
nav { display: flex; gap: 1rem; margin-top: 1rem; }
</style>
