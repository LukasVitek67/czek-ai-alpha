<script>
  import Sidebar from './lib/Sidebar.svelte';
  import TrackList from './lib/TrackList.svelte';
</script>

<div class="layout">
  <Sidebar />
  <main>
    <h1>Tunes</h1>
    <TrackList />
  </main>
</div>

<style>
  .layout { display: flex; min-height: 100vh; font-family: system-ui, sans-serif; }
  main { flex: 1; padding: 16px 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
</style>
