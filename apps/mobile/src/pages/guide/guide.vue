<template>
  <view class="guide">
    <swiper class="swiper" :current="current" @change="onSwipe">
      <swiper-item v-for="s in screens" :key="s.title" class="screen">
        <text class="icon">{{ s.icon }}</text>
        <text class="gtitle">{{ s.title }}</text>
        <text class="gdesc">{{ s.desc }}</text>
      </swiper-item>
    </swiper>
    <view class="dots">
      <view v-for="(s, i) in screens" :key="i" class="dot" :class="{ on: i === current }" />
    </view>
    <button v-if="current < screens.length - 1" class="skip" @click="finish">跳过</button>
    <button v-else class="start" @click="finish">开始使用</button>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { bootstrap } from '../../platform';

interface GuideScreen {
  icon: string;
  title: string;
  desc: string;
}

const screens: GuideScreen[] = [
  {
    icon: '🎓',
    title: '欢迎来到 base',
    desc: 'base 是面向学习者的内容平台。\n课程、文章、创作，都在这里。',
  },
  {
    icon: '📚',
    title: '学课程 · 看文章 · 投稿创作',
    desc: '学课程：跟着课时一步步学；\n看文章：随手读、随手记；\n投稿创作：把你的内容发出来。',
  },
  {
    icon: '🚀',
    title: '开始使用',
    desc: '一切就绪，\n从课程首页开始吧。',
  },
];

const current = ref(0);

function onSwipe(e: { detail?: { current?: number } }) {
  current.value = e.detail?.current ?? 0;
}

/** 写 guide_seen 标记（course.vue onShow 据此不再跳引导）；写失败也不阻断进入首页 */
async function finish() {
  try {
    const { repo } = await bootstrap();
    await repo.setConfig('guide_seen', '1');
  } catch {
    // 静默
  }
  uni.switchTab({ url: '/pages/course/course' });
}
</script>

<style>
.guide { display: flex; flex-direction: column; height: 100vh; padding: 16px; box-sizing: border-box; }
.swiper { flex: 1; }
.screen { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 24px; }
.icon { font-size: calc(var(--fs-title) * 4); margin-bottom: 24px; }
.gtitle { font-size: var(--fs-title); font-weight: 600; margin-bottom: 16px; }
.gdesc { font-size: var(--fs-body); line-height: 1.6; color: #666666; white-space: pre-line; }
.dots { display: flex; justify-content: center; padding: 12px 0; }
.dot { width: 10px; height: 10px; border-radius: 5px; background: #dddddd; margin: 0 5px; }
.dot.on { background: #2b6cb0; }
.skip { min-height: 48px; background: transparent; color: #999999; font-size: var(--fs-annotate); }
.start { min-height: 52px; background: #2b6cb0; color: #ffffff; font-size: var(--fs-body); }
</style>
