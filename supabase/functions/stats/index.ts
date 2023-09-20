import { z } from 'https://deno.land/x/zod@v3.22.2/mod.ts'
import { serve } from 'https://deno.land/std@0.200.0/http/server.ts'
import * as semver from 'https://deno.land/x/semver@v1.4.1/mod.ts'
import { methodJson, sendRes, reverseDomainRegex, deviceIdRegex } from '../_utils/utils.ts'
import { supabaseAdmin, updateOnpremStats } from '../_utils/supabase.ts'
import type { AppStats, BaseHeaders } from '../_utils/types.ts'
import type { Database } from '../_utils/supabase.types.ts'
import { sendNotif } from '../_utils/notifications.ts'
import { logsnag } from '../_utils/logsnag.ts'
import { appIdToUrl } from './../_utils/conversion.ts'

const failActions = [
  'set_fail',
  'update_fail',
  'download_fail',
]

// ios sends 13 fields while android sends 11 fields
const jsonRequestSchema = z.object({
  app_id: z.string({
    required_error: "App ID is required",
    invalid_type_error: "App ID name must be a string",
  }),
  device_id: z.string({
    required_error: "Device ID is required",
    invalid_type_error: "Device ID must be a string",
  }).max(36),
  platform: z.string({
    required_error: "Platform type is required",
    invalid_type_error: "Platform type must be a string",
  }),
  version_name: z.string({
    required_error: "Version name is required",
    invalid_type_error: "Version name must be a string",
  }),
  version_os: z.string({
    required_error: "Version OS is required",
    invalid_type_error: "Version OS must be a string",
  }),
  version_code: z.optional(z.string()),
  version_build: z.optional(z.string()),
  action: z.optional(z.string()),
  custom_id: z.optional(z.string()),
  channel: z.optional(z.string()),
  plugin_version: z.optional(z.string()),
  is_emulator: z.optional(z.boolean()),
  is_prod: z.optional(z.boolean()),
})
.refine((data) => reverseDomainRegex.test(data.app_id), {
  message: "App ID name must be a reverse domain string",
}).refine((data) => deviceIdRegex.test(data.device_id), {
  message: "Device ID must be a valid UUID string"
});

async function main(url: URL, headers: BaseHeaders, method: string, body: AppStats) {
  try {
    console.log('body', body)
    let {
      version_name,
      version_build,
    } = body
    const {
      platform,
      app_id,
      version_os,
      device_id,
      action,
      plugin_version = '2.3.3',
      custom_id,
      is_emulator = false,
      is_prod = true,
    } = body

  const parseResult = jsonRequestSchema.passthrough().safeParse(body)
  if (!parseResult.success)
    return sendRes({ error: `Cannot parse json: ${parseResult.error}` }, 400)

    const coerce = semver.coerce(version_build)

    const { data: appOwner } = await supabaseAdmin()
      .from('apps')
      .select('user_id, app_id')
      .eq('app_id', app_id)
      .single()

    if (!appOwner) {
      if (app_id) {
        await supabaseAdmin()
          .from('store_apps')
          .upsert({
            app_id,
            onprem: true,
            capacitor: true,
            capgo: true,
          })
      }
      if (action === 'get') {
        await updateOnpremStats({
          app_id,
          updates: 1,
        })
      }
      return sendRes({
        message: 'App not found',
        error: 'app_not_found',
      }, 200)
    }

    if (coerce)
      version_build = coerce.version
    console.log(`VERSION NAME: ${version_name}`)
    version_name = !version_name ? version_build : version_name
    const device: Database['public']['Tables']['devices']['Insert'] = {
      platform: platform as Database['public']['Enums']['platform_os'],
      device_id,
      app_id,
      plugin_version,
      os_version: version_os,
      version: version_name || 'unknown' as any,
      is_emulator: is_emulator == null ? false : is_emulator,
      is_prod: is_prod == null ? true : is_prod,
      ...(custom_id != null ? { custom_id } : {}),
    }

    const stat: Database['public']['Tables']['stats']['Insert'] = {
      platform: platform as Database['public']['Enums']['platform_os'],
      device_id,
      action,
      app_id,
      version_build,
      version: 0,
    }
    const rows: Database['public']['Tables']['stats']['Insert'][] = []
    const all = []
    const { data: appVersion } = await supabaseAdmin()
      .from('app_versions')
      .select('id, user_id')
      .eq('app_id', app_id)
      .or(`name.eq.${version_name}`)
      .single()
    console.log(`appVersion ${JSON.stringify(appVersion)}`)
    if (appVersion) {
      stat.version = appVersion.id
      device.version = appVersion.id
      if (action === 'set' && !device.is_emulator && device.is_prod) {
        const { data: deviceData } = await supabaseAdmin()
          .from('devices')
          .select()
          .eq('app_id', app_id)
          .eq('device_id', device_id)
          .single()
        if (deviceData && deviceData.version !== appVersion.id) {
          const statUninstall = {
            ...stat,
            action: 'uninstall',
            version_id: deviceData.version,
          }
          rows.push(statUninstall)
        }
      }
      else if (failActions.includes(action)) {
        console.log('FAIL!')
        const sent = await sendNotif('user:update_fail', {
          current_app_id: app_id,
          current_device_id: device_id,
          current_version_id: appVersion.id,
          current_app_id_url: appIdToUrl(app_id),
        }, appVersion.user_id, '0 0 * * 1', 'orange')
        if (sent) {
          await logsnag.track({
            channel: 'updates',
            event: 'update fail',
            icon: '⚠️',
            user_id: appVersion.user_id,
            notify: true,
          }).catch()
        }
      }
    }
    else {
      console.error('switch to onprem', app_id)
      return sendRes({
        message: 'App not found',
        error: 'app_not_found',
      }, 200)
    }
    rows.push(stat)
    all.push(supabaseAdmin()
      .from('devices')
      .upsert(device)
      .then(() => supabaseAdmin()
        .from('stats')
        .insert(rows)))
    await Promise.all(all)
    return sendRes()
  }
  catch (e) {
    return sendRes({
      status: 'Error unknow',
      error: JSON.stringify(e),
    }, 500)
  }
}

serve(async (event: Request) => {
  try {
    const url: URL = new URL(event.url)
    const headers: BaseHeaders = Object.fromEntries(event.headers.entries())
    const method: string = event.method
    const body: any = methodJson.includes(method) ? await event.json() : Object.fromEntries(url.searchParams.entries())
    return main(url, headers, method, body)
  }
  catch (e) {
    return sendRes({ status: 'Error', error: JSON.stringify(e) }, 500)
  }
})
