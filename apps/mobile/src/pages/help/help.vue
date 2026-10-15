<template>
  <view class="wrap">
    <navigator open-type="navigateBack" class="back">‹ 返回</navigator>

    <view v-for="s in sections" :key="s.title" class="card">
      <text class="htitle">{{ s.title }}</text>
      <text v-for="(line, i) in s.lines" :key="i" class="hline">{{ line }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
interface HelpSection {
  title: string;
  lines: string[];
}

const sections: HelpSection[] = [
  {
    title: '首页怎么用',
    lines: [
      '打开 base 首页，宫格里是四个入口：学课程、看文章、去投稿、我的。',
      '点「学课程」滚到课程列表，挑一门课开始；点「看文章」随手阅读。',
      '顶部搜索框可以搜课程和文章。',
    ],
  },
  {
    title: '怎么投稿',
    lines: [
      '点底部 tab「投稿」，先选投稿类型。',
      '写正文：工具栏可以调字号、颜色、插图库里的图片。',
      '写完保存，作品会出现在「我的 → 我创建的」里。',
    ],
  },
  {
    title: '圈子怎么玩',
    lines: [
      '点底部 tab「圈子」，可以新建圈子，开放圈人人可进，封闭圈凭邀请码进入。',
      '圈内可以发言，还能引用课程和文章一起讨论。',
    ],
  },
  {
    title: '私有笔记',
    lines: [
      '入口在「我的 → 我的笔记」。',
      '笔记只保存在本机，仅自己可见；换手机不会带走。',
    ],
  },
];
</script>

<style>
.wrap { padding: 16px; }
.back { display: flex; align-items: center; min-height: 48px; color: #2b6cb0; font-size: var(--fs-body); }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
.htitle { display: block; font-size: var(--fs-title); font-weight: 600; margin-bottom: 8px; }
.hline { display: block; font-size: var(--fs-body); line-height: 1.6; color: #333333; margin-bottom: 4px; }
</style>
