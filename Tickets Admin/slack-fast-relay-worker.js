/**
 * Fast Slack relay for Tickets Admin.
 *
 * Use this as the Slack Request URL for Slash Commands and Interactivity.
 * It acknowledges Slack immediately, opens the modal from Cloudflare Worker,
 * and forwards submissions/status actions to Google Apps Script in the background.
 *
 * Required Cloudflare Worker environment variables:
 * - SLACK_SIGNING_SECRET
 * - SLACK_BOT_TOKEN
 * - APPS_SCRIPT_URL
 *
 * Optional:
 * - APPS_SCRIPT_RELAY_SECRET
 * - ADMIN_USER_IDS: comma/space-separated Slack user IDs allowed to use /add before the modal opens
 * - TICKET_TYPE_OPTIONS: optional comma/newline-separated fallback ticket types
 */

const CALLBACKS = {
  shortcut: 'ticket_create_shortcut',
  modal: 'ticket_create_modal',
  outsideTaskModal: 'outside_task_modal',
  rejectModal: 'ticket_reject_modal',
  take: 'take_ticket',
  done: 'done_ticket',
  reject: 'reject_ticket',
};

const BLOCKS = {
  type: 'ticket_type_block',
  region: 'region_block',
  priority: 'priority_block',
  details: 'details_block',
  files: 'files_block',
  outsideTaskCount: 'outside_task_count_block',
  outsideTaskDetails: 'outside_task_details_block',
  rejectReason: 'reject_reason_block',
};

const ACTIONS = {
  type: 'ticket_type_input',
  region: 'region_input',
  priority: 'priority_select',
  details: 'details_input',
  files: 'files_input',
  outsideTaskCount: 'outside_task_count_select',
  outsideTaskDetails: 'outside_task_details_input',
  rejectReason: 'reject_reason_input',
};

const DEFAULT_TICKET_TYPES = [
  'Добавить анализ',
  'Добавить реф значение',
  'Включить склад 2.0',
  'Включить ЛИС',
  'Связка клиник',
  'Другое',
];

const TICKET_TYPES_CACHE_TTL_MS = 60 * 1000;
const TICKET_CONTEXTS = {
  admin: 'admin',
  support: 'support',
};

let ticketTypesCache = {
  expiresAt: 0,
  options: null,
};

export default {
  async fetch(request, env, ctx) {
    const ticketTypeCacheResponse = await handleTicketTypeCacheRequest_(request, env);

    if (ticketTypeCacheResponse) {
      return ticketTypeCacheResponse;
    }

    if (request.method !== 'POST') {
      return new Response('Tickets Admin Slack relay is running.', { status: 200 });
    }

    const rawBody = await request.text();

    if (!(await isValidSlackRequest_(request, rawBody, env.SLACK_SIGNING_SECRET))) {
      return new Response('invalid signature', { status: 401 });
    }

    const slackRequest = parseSlackRequest_(rawBody);

    if (slackRequest.kind === 'slash_command') {
      if (slackRequest.command === '/ticket') {
        ctx.waitUntil(refreshTicketTypeOptions_(env, 2500).catch((error) => console.error(error)));
        ctx.waitUntil(openTicketModal_(env, slackRequest.triggerId));

        return jsonResponse_({
          response_type: 'ephemeral',
          text: 'Открываю форму создания тикета.',
        });
      }

      if (slackRequest.command === '/support') {
        ctx.waitUntil(openSupportTicketModal_(env, slackRequest.triggerId));

        return jsonResponse_({
          response_type: 'ephemeral',
          text: 'Открываю форму создания тикета техподдержки.',
        });
      }

      if (slackRequest.command === '/report') {
        ctx.waitUntil(forwardToAppsScript_(env, {
          type: 'report_command',
          token: slackRequest.token,
          command: slackRequest.command,
          text: slackRequest.text,
          user_id: slackRequest.userId,
          user_name: slackRequest.userName,
          channel_id: slackRequest.channelId,
          response_url: slackRequest.responseUrl,
        }));

        return jsonResponse_({
          response_type: 'ephemeral',
          text: 'Готовлю отчет. Он появится здесь через несколько секунд.',
        });
      }

      if (slackRequest.command === '/support-report') {
        ctx.waitUntil(forwardToAppsScript_(env, {
          type: 'support_report_command',
          token: slackRequest.token,
          command: slackRequest.command,
          text: slackRequest.text,
          user_id: slackRequest.userId,
          user_name: slackRequest.userName,
          channel_id: slackRequest.channelId,
          response_url: slackRequest.responseUrl,
        }));

        return jsonResponse_({
          response_type: 'ephemeral',
          text: 'Готовлю отчет техподдержки. Он появится здесь через несколько секунд.',
        });
      }

      if (slackRequest.command === '/add') {
        if (!isAdmin_(slackRequest.userId, env.ADMIN_USER_IDS)) {
          return jsonResponse_({
            response_type: 'ephemeral',
            text: outsideTaskAccessDeniedText_(),
          });
        }

        ctx.waitUntil(openOutsideTaskModal_(env, slackRequest.triggerId));

        return jsonResponse_({
          response_type: 'ephemeral',
          text: 'Открываю форму добавления вне Slack задач.',
        });
      }

      return jsonResponse_({
        response_type: 'ephemeral',
        text: 'Эта автоматизация обрабатывает команды /ticket, /support, /add, /report и /support-report.',
      });
    }

    if (slackRequest.kind !== 'payload') {
      return jsonResponse_({});
    }

    const payload = slackRequest.payload;

    if (payload.type === 'block_suggestion' && payload.action_id === ACTIONS.type) {
      return jsonResponse_(await ticketTypeOptionsResponse_(env, payload, ctx));
    }

    if (payload.type === 'shortcut' && payload.callback_id === CALLBACKS.shortcut) {
      ctx.waitUntil(refreshTicketTypeOptions_(env, 2500).catch((error) => console.error(error)));
      ctx.waitUntil(openTicketModal_(env, payload.trigger_id));
      return jsonResponse_({});
    }

    if (
      payload.type === 'view_submission' &&
      payload.view &&
      [CALLBACKS.modal, CALLBACKS.outsideTaskModal, CALLBACKS.rejectModal].includes(payload.view.callback_id)
    ) {
      ctx.waitUntil(forwardToAppsScript_(env, payload));
      return jsonResponse_({ response_action: 'clear' });
    }

    if (payload.type === 'block_actions') {
      const action = payload.actions && payload.actions[0];
      const actionValue = action ? parseTicketActionValue_(action.value) : {};
      const assigneeWarning = action ? assigneeActionWarningFromValue_(payload.user && payload.user.id, actionValue) : '';

      if (assigneeWarning && [CALLBACKS.done, CALLBACKS.reject].includes(action.action_id)) {
        ctx.waitUntil(postEphemeral_(env, payload, assigneeWarning));
        return jsonResponse_({});
      }

      if (action && action.action_id === CALLBACKS.reject) {
        ctx.waitUntil(openRejectModal_(env, payload, actionValue.ticketId, actionValue.context));
        return jsonResponse_({});
      }

      ctx.waitUntil(forwardToAppsScript_(env, payload));
      return jsonResponse_({});
    }

    ctx.waitUntil(forwardToAppsScript_(env, payload));
    return jsonResponse_({});
  },
};

function parseSlackRequest_(rawBody) {
  const params = new URLSearchParams(rawBody);

  if (params.has('payload')) {
    return {
      kind: 'payload',
      payload: JSON.parse(params.get('payload')),
    };
  }

  return {
    kind: 'slash_command',
    command: params.get('command') || '',
    token: params.get('token') || '',
    triggerId: params.get('trigger_id') || '',
    userId: params.get('user_id') || '',
    userName: params.get('user_name') || '',
    channelId: params.get('channel_id') || '',
    responseUrl: params.get('response_url') || '',
    text: params.get('text') || '',
  };
}

function parseTicketActionValue_(value) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return {
      ticketId: '',
      assigneeId: '',
    };
  }

  if (rawValue.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(rawValue);

      return {
        ticketId: String(parsed.ticketId || '').trim(),
        assigneeId: String(parsed.assigneeId || '').trim(),
        context: normalizeTicketContext_(parsed.context || ticketContextFromId_(parsed.ticketId)),
      };
    } catch (error) {
      return {
        ticketId: rawValue,
        assigneeId: '',
        context: ticketContextFromId_(rawValue),
      };
    }
  }

  return {
    ticketId: rawValue,
    assigneeId: '',
    context: ticketContextFromId_(rawValue),
  };
}

function normalizeTicketContext_(context) {
  return context === TICKET_CONTEXTS.support ? TICKET_CONTEXTS.support : TICKET_CONTEXTS.admin;
}

function ticketContextFromId_(ticketId) {
  return /^TS\d+$/i.test(String(ticketId || '').trim()) ? TICKET_CONTEXTS.support : TICKET_CONTEXTS.admin;
}

function assigneeActionWarningFromValue_(actorId, actionValue) {
  if (!actionValue.assigneeId || sameSlackUser_(actorId, actionValue.assigneeId)) {
    return '';
  }

  return `Этот тикет взял в работу <@${actionValue.assigneeId}>. Завершить или отклонить его может только этот администратор.`;
}

function isAdmin_(userId, adminUserIds) {
  const allowedIds = String(adminUserIds || '')
    .split(/[,\s]+/)
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean);

  if (!allowedIds.length) {
    return true;
  }

  return allowedIds.includes(String(userId || '').trim().toUpperCase());
}

function outsideTaskAccessDeniedText_() {
  return 'У вас нет прав на добавление вне Slack задач.';
}

function sameSlackUser_(left, right) {
  return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase();
}

async function postEphemeral_(env, payload, text) {
  const channel = (payload.channel && payload.channel.id) || (payload.container && payload.container.channel_id);
  const user = payload.user && payload.user.id;

  if (!channel || !user) {
    return;
  }

  const response = await fetch('https://slack.com/api/chat.postEphemeral', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      user,
      text,
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`chat.postEphemeral failed: ${JSON.stringify(data)}`);
  }
}

async function openTicketModal_(env, triggerId) {
  if (!triggerId) {
    throw new Error('Slack did not send trigger_id.');
  }

  const response = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: buildTicketModal_(),
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`views.open failed: ${JSON.stringify(data)}`);
  }
}

async function openSupportTicketModal_(env, triggerId) {
  if (!triggerId) {
    throw new Error('Slack did not send trigger_id for support modal.');
  }

  const response = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: buildSupportTicketModal_(),
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`support views.open failed: ${JSON.stringify(data)}`);
  }
}

async function openOutsideTaskModal_(env, triggerId) {
  if (!triggerId) {
    throw new Error('Slack did not send trigger_id for outside task modal.');
  }

  const response = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: buildOutsideTaskModal_(),
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`outside task views.open failed: ${JSON.stringify(data)}`);
  }
}

async function openRejectModal_(env, payload, ticketId, context) {
  if (!payload.trigger_id) {
    throw new Error('Slack did not send trigger_id for reject modal.');
  }

  const response = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      trigger_id: payload.trigger_id,
      view: buildRejectModal_(
        ticketId,
        (payload.channel && payload.channel.id) || (payload.container && payload.container.channel_id),
        (payload.container && payload.container.message_ts) || (payload.message && payload.message.thread_ts) || (payload.message && payload.message.ts),
        context
      ),
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`reject views.open failed: ${JSON.stringify(data)}`);
  }
}

async function forwardToAppsScript_(env, payload) {
  const response = await appsScriptFetch_(env, payload);

  if (!response.ok) {
    throw new Error(`Apps Script failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchAppsScriptJson_(env, payload, timeoutMs) {
  const response = await appsScriptFetch_(env, payload, timeoutMs);

  if (!response.ok) {
    throw new Error(`Apps Script failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function appsScriptFetch_(env, payload, timeoutMs) {
  const url = new URL(env.APPS_SCRIPT_URL);

  if (env.APPS_SCRIPT_RELAY_SECRET) {
    url.searchParams.set('relay_secret', env.APPS_SCRIPT_RELAY_SECRET);
  }

  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    return await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function handleTicketTypeCacheRequest_(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== '/ticket-types/cache') {
    return null;
  }

  const expectedSecret = env.APPS_SCRIPT_RELAY_SECRET || env.TICKET_TYPES_CACHE_SECRET || '';
  const providedSecret = url.searchParams.get('relay_secret') || request.headers.get('x-relay-secret') || '';

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return jsonResponse_({
      ok: false,
      error: 'forbidden',
    }, 403);
  }

  if (request.method === 'GET') {
    const cached = await readTicketTypeOptionsFromCache_();

    return jsonResponse_({
      ok: true,
      options: cached ? cached.options : fallbackTicketTypeOptions_(''),
      cached: Boolean(cached),
      expiresAt: cached ? cached.expiresAt : 0,
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse_({
      ok: false,
      error: 'method_not_allowed',
    }, 405);
  }

  const body = await request.json().catch(() => ({}));
  const options = normalizeTicketTypeOptions_(body.options);

  await writeTicketTypeOptionsToCache_(options);

  return jsonResponse_({
    ok: true,
    count: options.length,
  });
}

async function ticketTypeOptionsResponse_(env, payload, ctx) {
  const cached = await getFastTicketTypeOptions_();

  if (cached && cached.options.length) {
    if (cached.isStale && ctx) {
      ctx.waitUntil(refreshTicketTypeOptions_(env, 2500).catch((refreshError) => console.error(refreshError)));
    }

    return {
      options: filterTicketTypeOptions_(cached.options, payload.value || ''),
    };
  }

  try {
    const options = await refreshTicketTypeOptions_(env, 2400);
    return {
      options: filterTicketTypeOptions_(options, payload.value || ''),
    };
  } catch (error) {
    const fallbackOptions = configuredFallbackTicketTypeOptions_(env);

    if (ctx) {
      ctx.waitUntil(refreshTicketTypeOptions_(env, 2500).catch((refreshError) => console.error(refreshError)));
    }

    return {
      options: filterTicketTypeOptions_(fallbackOptions, payload.value || ''),
    };
  }
}

async function getFastTicketTypeOptions_() {
  const now = Date.now();

  if (ticketTypesCache.options && ticketTypesCache.options.length) {
    return {
      options: ticketTypesCache.options,
      isStale: ticketTypesCache.expiresAt <= now,
    };
  }

  const cached = await readTicketTypeOptionsFromCache_();

  if (!cached || !cached.options.length) {
    return null;
  }

  ticketTypesCache = {
    expiresAt: cached.expiresAt,
    options: cached.options,
  };

  return {
    options: cached.options,
    isStale: cached.expiresAt <= now,
  };
}

async function refreshTicketTypeOptions_(env, timeoutMs) {
  const response = await fetchAppsScriptJson_(env, {
    type: 'block_suggestion',
    action_id: ACTIONS.type,
    value: '',
  }, timeoutMs || 2600);
  const options = normalizeTicketTypeOptions_(response.options);

  await writeTicketTypeOptionsToCache_(options);

  return options;
}

async function readTicketTypeOptionsFromCache_() {
  if (typeof caches === 'undefined' || !caches.default) {
    return ticketTypesCache.options ? {
      expiresAt: ticketTypesCache.expiresAt,
      options: ticketTypesCache.options,
    } : null;
  }

  const response = await caches.default.match(ticketTypeCacheRequest_());

  if (!response) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const options = payload ? normalizeTicketTypeOptions_(payload.options) : [];

  if (!options.length) {
    return null;
  }

  return {
    expiresAt: Number(payload.expiresAt) || 0,
    options,
  };
}

async function writeTicketTypeOptionsToCache_(options) {
  const normalizedOptions = normalizeTicketTypeOptions_(options);
  const expiresAt = Date.now() + TICKET_TYPES_CACHE_TTL_MS;

  ticketTypesCache = {
    expiresAt,
    options: normalizedOptions,
  };

  if (typeof caches === 'undefined' || !caches.default) {
    return;
  }

  await caches.default.put(ticketTypeCacheRequest_(), new Response(JSON.stringify({
    expiresAt,
    options: normalizedOptions,
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  }));
}

function ticketTypeCacheRequest_() {
  return new Request('https://tickets-admin.local/ticket-types-cache', {
    method: 'GET',
  });
}

function normalizeTicketTypeOptions_(options) {
  if (!Array.isArray(options) || !options.length) {
    return DEFAULT_TICKET_TYPES.map(ticketTypeOption_);
  }

  return options
    .map((option) => {
      const text = option && option.text && option.text.text;
      return text ? ticketTypeOption_(text) : null;
    })
    .filter(Boolean)
    .slice(0, 100);
}

function fallbackTicketTypeOptions_(query) {
  return filterTicketTypeOptions_(configuredFallbackTicketTypeOptions_({}), query);
}

function configuredFallbackTicketTypeOptions_(env) {
  const configuredTypes = String(env.TICKET_TYPE_OPTIONS || '')
    .split(/[\n,]+/)
    .map((type) => type.trim())
    .filter(Boolean);

  const types = configuredTypes.length ? configuredTypes : DEFAULT_TICKET_TYPES;

  return types.map(ticketTypeOption_);
}

function filterTicketTypeOptions_(options, query) {
  const normalizedQuery = normalizeOptionText_(query);

  return options
    .filter((option) => {
      const text = option && option.text && option.text.text;
      return text && (!normalizedQuery || normalizeOptionText_(text).includes(normalizedQuery));
    })
    .slice(0, 100);
}

function ticketTypeOption_(name) {
  const text = truncatePlainText_(name, 75);

  return {
    text: {
      type: 'plain_text',
      text,
    },
    value: text,
  };
}

function normalizeOptionText_(value) {
  return String(value || '').trim().toLowerCase();
}

function truncatePlainText_(value, maxLength) {
  const text = String(value || '').trim();

  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }

  return text.slice(0, maxLength - 3) + '...';
}

function buildTicketModal_() {
  return {
    type: 'modal',
    callback_id: CALLBACKS.modal,
    title: {
      type: 'plain_text',
      text: 'Создать тикет',
    },
    submit: {
      type: 'plain_text',
      text: 'Отправить',
    },
    close: {
      type: 'plain_text',
      text: 'Отмена',
    },
    blocks: [
      {
        type: 'input',
        block_id: BLOCKS.type,
        label: {
          type: 'plain_text',
          text: 'Тип заявки',
        },
        element: {
          type: 'external_select',
          action_id: ACTIONS.type,
          min_query_length: 0,
          placeholder: {
            type: 'plain_text',
            text: 'Выберите тип заявки',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.region,
        label: {
          type: 'plain_text',
          text: 'Регион / ОП / ID клиники',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTIONS.region,
          placeholder: {
            type: 'plain_text',
            text: 'Ташкентская область, Олмазорский район или ID клиники',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.priority,
        label: {
          type: 'plain_text',
          text: 'Приоритет',
        },
        element: {
          type: 'static_select',
          action_id: ACTIONS.priority,
          initial_option: priorityOption_('normal', 'Обычный'),
          options: [
            priorityOption_('low', 'Низкий'),
            priorityOption_('normal', 'Обычный'),
            priorityOption_('high', 'Высокий'),
            priorityOption_('urgent', 'Срочный'),
          ],
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.details,
        label: {
          type: 'plain_text',
          text: 'Детали задачи',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTIONS.details,
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Опишите, что нужно сделать и какие данные важны для выполнения.',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.files,
        optional: true,
        label: {
          type: 'plain_text',
          text: 'Фото',
        },
        hint: {
          type: 'plain_text',
          text: 'Можно прикрепить до 5 фото. Они автоматически уйдут в тред тикета.',
        },
        element: {
          type: 'file_input',
          action_id: ACTIONS.files,
          filetypes: ['jpg', 'jpeg', 'png', 'gif'],
          max_files: 5,
        },
      },
    ],
  };
}

function buildSupportTicketModal_() {
  return {
    type: 'modal',
    callback_id: CALLBACKS.modal,
    private_metadata: JSON.stringify({
      context: TICKET_CONTEXTS.support,
    }),
    title: {
      type: 'plain_text',
      text: 'Задача техподдержки',
    },
    submit: {
      type: 'plain_text',
      text: 'Отправить',
    },
    close: {
      type: 'plain_text',
      text: 'Отмена',
    },
    blocks: [
      {
        type: 'input',
        block_id: BLOCKS.region,
        label: {
          type: 'plain_text',
          text: 'Мед учреждение',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTIONS.region,
          placeholder: {
            type: 'plain_text',
            text: 'Например: Алмазар 17 ОП',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.details,
        label: {
          type: 'plain_text',
          text: 'Что нужно сделать',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTIONS.details,
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Например: отправить 3 сотрудников туда',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.priority,
        label: {
          type: 'plain_text',
          text: 'Приоритет',
        },
        element: {
          type: 'static_select',
          action_id: ACTIONS.priority,
          initial_option: priorityOption_('normal', 'Обычный'),
          options: [
            priorityOption_('low', 'Низкий'),
            priorityOption_('normal', 'Обычный'),
            priorityOption_('high', 'Высокий'),
            priorityOption_('urgent', 'Срочный'),
          ],
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.files,
        optional: true,
        label: {
          type: 'plain_text',
          text: 'Фото',
        },
        hint: {
          type: 'plain_text',
          text: 'Можно прикрепить до 5 фото. Они автоматически уйдут в тред тикета.',
        },
        element: {
          type: 'file_input',
          action_id: ACTIONS.files,
          filetypes: ['jpg', 'jpeg', 'png', 'gif'],
          max_files: 5,
        },
      },
    ],
  };
}

function buildOutsideTaskModal_() {
  return {
    type: 'modal',
    callback_id: CALLBACKS.outsideTaskModal,
    title: {
      type: 'plain_text',
      text: 'Вне Slack задачи',
    },
    submit: {
      type: 'plain_text',
      text: 'Добавить',
    },
    close: {
      type: 'plain_text',
      text: 'Отмена',
    },
    blocks: [
      {
        type: 'input',
        block_id: BLOCKS.outsideTaskCount,
        label: {
          type: 'plain_text',
          text: 'Сколько задач выполнено?',
        },
        element: {
          type: 'static_select',
          action_id: ACTIONS.outsideTaskCount,
          initial_option: outsideTaskCountOption_(1),
          options: Array.from({ length: 30 }, (_, index) => outsideTaskCountOption_(index + 1)),
        },
      },
      {
        type: 'input',
        block_id: BLOCKS.outsideTaskDetails,
        label: {
          type: 'plain_text',
          text: 'Какие задачи выполнены?',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTIONS.outsideTaskDetails,
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '1. Добавил услуги в дерматологию\n2. Добавил аптеки',
          },
        },
      },
    ],
  };
}

function outsideTaskCountOption_(count) {
  return {
    text: {
      type: 'plain_text',
      text: String(count),
    },
    value: String(count),
  };
}

function buildRejectModal_(ticketId, channelId, messageTs, context) {
  return {
    type: 'modal',
    callback_id: CALLBACKS.rejectModal,
    private_metadata: JSON.stringify({
      ticketId,
      channelId,
      messageTs,
      context: normalizeTicketContext_(context || ticketContextFromId_(ticketId)),
    }),
    title: {
      type: 'plain_text',
      text: 'Причина отказа',
    },
    submit: {
      type: 'plain_text',
      text: 'Отклонить',
    },
    close: {
      type: 'plain_text',
      text: 'Отмена',
    },
    blocks: [
      {
        type: 'input',
        block_id: BLOCKS.rejectReason,
        label: {
          type: 'plain_text',
          text: 'Почему тикет отклоняется?',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTIONS.rejectReason,
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Кратко опишите причину отказа. Текст будет отправлен автору в тред.',
          },
        },
      },
    ],
  };
}

function priorityOption_(value, label) {
  return {
    text: {
      type: 'plain_text',
      text: label,
    },
    value,
  };
}

async function isValidSlackRequest_(request, rawBody, signingSecret) {
  if (!signingSecret) {
    return false;
  }

  const timestamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';
  const now = Math.floor(Date.now() / 1000);

  if (!timestamp || Math.abs(now - Number(timestamp)) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const expected = `v0=${hex_(digest)}`;

  return timingSafeEqual_(expected, signature);
}

function hex_(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual_(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return result === 0;
}

function jsonResponse_(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
