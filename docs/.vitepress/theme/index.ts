import DefaultTheme from 'vitepress/theme'
import HomePage from './HomePage.vue'
import ContentHub from './ContentHub.vue'
import ProgressPage from './ProgressPage.vue'
import StudioPage from './StudioPage.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomePage', HomePage)
    app.component('ContentHub', ContentHub)
    app.component('ProgressPage', ProgressPage)
    app.component('StudioPage', StudioPage)
  }
}
