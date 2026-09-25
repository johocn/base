<template>
  <view class="wrap">
    <text class="title">base 学习</text>
    <text class="hint">内容目录将在后续任务接入</text>
    <navigator url="/pages/setting/setting" class="link">前往设置</navigator>
  </view>
</template>

<script setup lang="ts"></script>

<style>
.wrap { padding: 24px; display: flex; flex-direction: column; gap: 10px; }
.title { font-size: 20px; font-weight: 600; }
.hint { color: #888; }
.link { color: #2b6cb0; }
</style>