import DefaultTheme from 'vitepress/theme'
import Layout from './Layout.vue'
import HomePage from './HomePage.vue'
import ContentHub from './ContentHub.vue'
import ProgressPage from './ProgressPage.vue'
import StudioPage from './StudioPage.vue'
import AuthPage from './AuthPage.vue'
import AdminPage from './AdminPage.vue'
import BuyPage from './BuyPage.vue'
import MePage from './MePage.vue'
import OrderPage from './OrderPage.vue'
import CsPage from './CsPage.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  // 覆写 Layout 而不是用插槽：每个 .md 都写了 layout: false，那时默认主题的插槽一个都不渲染，
  // 而客服挂件要出现在每一页上。
  Layout,
  enhanceApp({ app }) {
    app.component('HomePage', HomePage)
    app.component('ContentHub', ContentHub)
    app.component('ProgressPage', ProgressPage)
    app.component('StudioPage', StudioPage)
    app.component('AuthPage', AuthPage)
    app.component('AdminPage', AdminPage)
    app.component('BuyPage', BuyPage)
    app.component('MePage', MePage)
    app.component('OrderPage', OrderPage)
    app.component('CsPage', CsPage)
  }
}
