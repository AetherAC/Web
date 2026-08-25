import DefaultTheme from 'vitepress/theme'
import HomePage from './HomePage.vue'
import ContentHub from './ContentHub.vue'
import ProgressPage from './ProgressPage.vue'
import StudioPage from './StudioPage.vue'
import AuthPage from './AuthPage.vue'
import AdminPage from './AdminPage.vue'
import BuyPage from './BuyPage.vue'
import MePage from './MePage.vue'
import OrderPage from './OrderPage.vue'
import './style.css'

export default {
  extends: DefaultTheme,
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
  }
}
