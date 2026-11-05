import { hackedSiteSuite, SOURCES } from './hacked-suite.js'

hackedSiteSuite('SQL backup', SOURCES.sql, { backup: true })
