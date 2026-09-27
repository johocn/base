<template>
  <view class="wrap">
    <text class="title">我的</text>
    <navigator url="/pages/favorite/favorite" class="link">我的收藏</navigator>
    <navigator url="/pages/setting/setting" class="link">设置</navigator>
  </view>
</template>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 20px; }
.link { display: block; padding: 14px 0; border-bottom: 1px solid #eeeeee; color: #2b6cb0; }
</style>