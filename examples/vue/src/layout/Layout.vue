<template>
  <section class="layout">
    <header>Shared layout</header>
    <slot />
  </section>
</template>

<style scoped>
.layout { max-width: 60rem; margin: 2rem auto; padding: 1rem; font-family: sans-serif; }
header { border-bottom: 1px solid #42b883; padding-bottom: 1rem; }
</style>
