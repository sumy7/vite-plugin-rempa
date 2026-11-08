<script setup lang="ts">
const users = ['Ada', 'Grace', 'Linus']
</script>

<template>
  <h1>Users</h1>
  <ul>
    <li v-for="user in users" :key="user">
      {{ user }}
    </li>
  </ul>
</template>
