export interface BundledPlugin {
  id: string
  name: string
  version: string
  description: string
  fileName: string
}

export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    id: 'tetramatrix.social-seo',
    name: 'Social SEO',
    version: '2.0.0',
    description: 'Configurable Open Graph and Twitter Card metadata for published pages.',
    fileName: 'social-seo.plugin.zip',
  },
  {
    id: 'vigour.smtp',
    name: 'SMTP Form Delivery',
    version: '2.0.1',
    description: 'Reliable TLS SMTP delivery for CMS-native form submissions.',
    fileName: 'smtp-form-delivery.plugin.zip',
  },
]
