import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { BUNDLED_PLUGINS } from '@core/plugins/bundledCatalog'
import { readPluginPackage } from '../../../server/plugins/package'

describe('bundled plugins', () => {
  for (const bundled of BUNDLED_PLUGINS) {
    test(`${bundled.name} package matches the catalog`, async () => {
      const path = join(process.cwd(), 'public', 'bundled-plugins', bundled.fileName)
      const bytes = await Bun.file(path).arrayBuffer()
      const pluginPackage = await readPluginPackage(
        new File([bytes], bundled.fileName, { type: 'application/zip' }),
      )

      expect(pluginPackage.manifest.id).toBe(bundled.id)
      expect(pluginPackage.manifest.name).toBe(bundled.name)
      expect(pluginPackage.manifest.version).toBe(bundled.version)
    })
  }
})
