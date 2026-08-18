import { createApp } from 'vue'
import * as Vue from 'vue'
import App from './App.vue'

// 动态插件里的组件源码约定可用 window.Vue（ref / computed 等）
;(window as unknown as { Vue: typeof Vue }).Vue = Vue

createApp(App).mount('#app')
