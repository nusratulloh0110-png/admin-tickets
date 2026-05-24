/**
 * Tickets Admin automation for Slack + Google Sheets.
 *
 * Required Script Properties:
 * - SLACK_BOT_TOKEN: Bot token from Slack, starts with xoxb-
 * - SLACK_TICKETS_CHANNEL_ID: Channel ID for #tickets-admin, for example C0123456789
 *
 * Optional Script Properties:
 * - SPREADSHEET_ID: Spreadsheet used as the database; setup() creates one if empty
 * - SUPPORT_SPREADSHEET_ID: Separate spreadsheet for tech support data; setup() creates one if empty
 * - SLACK_REPORT_CHANNEL_ID: Channel ID for scheduled reports; defaults to SLACK_TICKETS_CHANNEL_ID
 * - ADMIN_USER_IDS: Fallback comma-separated Slack user IDs if Admins sheet is empty
 * - SLACK_SUPPORT_CHANNEL_ID: Channel ID for tech support lead tickets
 * - SLACK_SUPPORT_REPORT_CHANNEL_ID: Channel ID for tech support reports; defaults to SLACK_SUPPORT_CHANNEL_ID
 * - SUPPORT_ADMIN_USER_IDS: Fallback comma-separated Slack user IDs if Tech Support Admins sheet is empty
 * - SLACK_VERIFICATION_TOKEN: Legacy Slack verification token, if available
 * - RELAY_SHARED_SECRET: Optional shared secret accepted from the fast relay
 * - DIRECT_MODAL_OPENING: Set to true only if Slack points directly to Apps Script and it is fast enough
 * - REPORT_CUTOFF_AT: First date/time included in reports; setup() sets it once during this update
 * - WORKER_URL: Optional Cloudflare Worker URL used to pre-cache ticket types for fast Slack dropdowns
 *
 * Slack bot scopes:
 * - chat:write
 * - commands
 * - files:read
 */

const CONFIG = {
  SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN',
  SLACK_TICKETS_CHANNEL_ID: 'SLACK_TICKETS_CHANNEL_ID',
  SLACK_REPORT_CHANNEL_ID: 'SLACK_REPORT_CHANNEL_ID',
  SLACK_SUPPORT_CHANNEL_ID: 'SLACK_SUPPORT_CHANNEL_ID',
  SLACK_SUPPORT_REPORT_CHANNEL_ID: 'SLACK_SUPPORT_REPORT_CHANNEL_ID',
  ADMIN_USER_IDS: 'ADMIN_USER_IDS',
  SUPPORT_ADMIN_USER_IDS: 'SUPPORT_ADMIN_USER_IDS',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  SUPPORT_SPREADSHEET_ID: 'SUPPORT_SPREADSHEET_ID',
  SLACK_VERIFICATION_TOKEN: 'SLACK_VERIFICATION_TOKEN',
  RELAY_SHARED_SECRET: 'RELAY_SHARED_SECRET',
  DIRECT_MODAL_OPENING: 'DIRECT_MODAL_OPENING',
  REPORT_CUTOFF_AT: 'REPORT_CUTOFF_AT',
  WORKER_URL: 'WORKER_URL',
};

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

const SHEETS = {
  tickets: 'Tickets',
  events: 'Events',
  outsideTasks: 'Вне Slack задачи',
  personalDataAudit: 'Personal Data Audit',
  admins: 'Admins',
  ticketTypes: 'Типы заявок',
  dashboard: 'Dashboard',
  reports: 'Reports',
  outsideReport: 'Вне Slack аналитика',
  employeeReport: 'Employee Report',
  supportTickets: 'Tech Support Tickets',
  supportEvents: 'Tech Support Events',
  supportAdmins: 'Tech Support Admins',
  supportReports: 'Tech Support Reports',
  supportDashboard: 'Tech Support Dashboard',
};

const LEGACY_OUTSIDE_TASKS_SHEET_NAME = 'Outside Tasks';

const QUEUE = {
  ticketIds: 'PENDING_TICKET_IDS',
  ticketPrefix: 'PENDING_TICKET_',
  ticketHandler: 'processPendingTickets',
  actionIds: 'PENDING_ACTION_IDS',
  actionPrefix: 'PENDING_ACTION_',
  actionHandler: 'processPendingActions',
  retryLimit: 3,
  processingTimeoutMs: 10 * 60 * 1000,
};

const REPORTS = {
  weeklyHandler: 'sendWeeklyReport',
};

const REMINDERS = {
  handler: 'sendTicketReminders',
};

const TICKET_ID_SEQUENCE_KEY = 'TICKET_ID_SEQUENCE';
const SUPPORT_TICKET_ID_SEQUENCE_KEY = 'SUPPORT_TICKET_ID_SEQUENCE';
const SUPPORT_TICKET_TYPE = 'Техподдержка';

const TICKET_CONTEXTS = {
  admin: 'admin',
  support: 'support',
};

const TICKET_HEADERS = [
  'Ticket ID',
  'Date Created',
  'Author',
  'Author Name',
  'Ticket Type',
  'Region/Branch',
  'Priority',
  'Details',
  'Status',
  'Assignee',
  'Assignee Name',
  'Date Accepted',
  'Reaction Time',
  'Date Completed',
  'Resolution Time',
  'Slack Channel',
  'Slack Message TS',
  'Slack Thread TS',
  'Files',
  'Files Posted',
  'Redacted Fields',
  'Privacy Notice Sent',
  'Rejection Reason',
  'Unaccepted Reminder Sent',
  'In Progress Reminder Sent',
  'Responsible Notice Sent',
];

const EVENT_HEADERS = [
  'Timestamp',
  'Ticket ID',
  'Event',
  'Actor',
  'Status',
  'Notes',
];

const PERSONAL_DATA_AUDIT_HEADERS = [
  'Timestamp',
  'Ticket ID',
  'Author',
  'Author Name',
  'Redacted Fields',
  'Action',
  'Slack Channel',
  'Slack Message TS',
  'Notes',
];

const OUTSIDE_TASK_HEADERS = [
  'Timestamp',
  'Employee',
  'Employee Name',
  'Task Count',
  'Details',
  'Slack Channel',
];

const TICKET_TYPE_HEADERS = [
  'Тип заявки',
  'Активен',
  'Порядок',
  'Примечание',
  'Ответственный Slack ID',
  'Сообщение в тред',
];

const DEFAULT_TICKET_TYPES = [
  'Добавить анализ',
  'Добавить реф значение',
  'Включить склад 2.0',
  'Включить ЛИС',
  'Связка клиник',
  'Другое',
];

const ADMIN_HEADERS = [
  'Slack User ID',
  'Name',
  'Role',
  'Active',
  'Notes',
];

function doGet() {
  return textOutput_('Tickets Admin automation is running. Use Slack /ticket or the global shortcut to create a ticket.');
}

function doPost(e) {
  let request;

  try {
    request = parseSlackRequest_(e);

    if (!isVerifiedSlackRequest_(request)) {
      return jsonOutput_({
        response_type: 'ephemeral',
        text: 'Запрос не прошел проверку автоматизации.',
      });
    }

    if (request.kind === 'slash_command') {
      return handleSlashCommand_(request);
    }

    if (request.kind === 'payload') {
      const response = handleSlackPayload_(request.payload);

      processQueuesAfterPayload_(request.payload);

      return response;
    }

    return jsonOutput_({});
  } catch (error) {
    logRuntimeError_(error);

    if (request && request.payload && request.payload.type === 'view_submission') {
      const errorBlock = request.payload.view && request.payload.view.callback_id === CALLBACKS.rejectModal
        ? BLOCKS.rejectReason
        : BLOCKS.details;

      return jsonOutput_({
        response_action: 'errors',
        errors: {
          [errorBlock]: 'Не удалось обработать запрос. Проверьте настройки автоматизации или попробуйте еще раз.',
        },
      });
    }

    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Ошибка автоматизации: ' + friendlyError_(error),
    });
  }
}

/**
 * Run once from the Apps Script editor after filling Script Properties.
 * It creates/updates the database sheets, dashboard, and minute queue triggers.
 */
function setup() {
  const spreadsheet = getSpreadsheet_();
  const supportSpreadsheet = getSupportSpreadsheet_();
  migrateSupportDataToDedicatedSpreadsheet_(spreadsheet, supportSpreadsheet);
  ensureTicketsSheet_(true);
  ensureEventsSheet_(true);
  ensureTicketsSheet_(true, TICKET_CONTEXTS.support);
  ensureEventsSheet_(true, TICKET_CONTEXTS.support);
  ensureOutsideTasksSheet_(true);
  ensurePersonalDataAuditSheet_(true);
  ensurePersonalDataAuditSheet_(true, TICKET_CONTEXTS.support);
  ensureAdminsSheet_(true);
  ensureSupportAdminsSheet_(true);
  ensureTicketTypesSheet_(true);
  installTicketTypeSyncTrigger_();
  safeSyncTicketTypesToWorker_();
  primeTicketIdSequence_();
  primeTicketIdSequence_(TICKET_CONTEXTS.support);
  ensureReportCutoff_();
  refreshDashboard_();
  refreshReportsSheet_();
  refreshSupportDashboard_();
  refreshSupportReportsSheet_();
  refreshEmployeeReportSheet_();
  installQueueTriggers_();
  installWeeklyReportTrigger_();
  installReminderTrigger_();
  removeEmptyDefaultSupportSheet_(supportSpreadsheet);

  return 'Готово. Основная таблица: ' + spreadsheet.getUrl() + '\nТехподдержка: ' + supportSpreadsheet.getUrl();
}

function normalizeTicketContext_(context) {
  return context === TICKET_CONTEXTS.support ? TICKET_CONTEXTS.support : TICKET_CONTEXTS.admin;
}

function isSupportContext_(context) {
  return normalizeTicketContext_(context) === TICKET_CONTEXTS.support;
}

function ticketContextFromId_(ticketId) {
  return /^TS\d+$/i.test(String(ticketId || '').trim()) ? TICKET_CONTEXTS.support : TICKET_CONTEXTS.admin;
}

function ticketContextFromMetadata_(value) {
  try {
    const metadata = JSON.parse(value || '{}');
    return normalizeTicketContext_(metadata.context);
  } catch (error) {
    return TICKET_CONTEXTS.admin;
  }
}

function ticketContextFromView_(view) {
  return ticketContextFromMetadata_(view && view.private_metadata);
}

function ticketSheetName_(context) {
  return isSupportContext_(context) ? SHEETS.supportTickets : SHEETS.tickets;
}

function eventSheetName_(context) {
  return isSupportContext_(context) ? SHEETS.supportEvents : SHEETS.events;
}

function reportSheetName_(context) {
  return isSupportContext_(context) ? SHEETS.supportReports : SHEETS.reports;
}

function spreadsheetForContext_(context) {
  return isSupportContext_(context) ? getSupportSpreadsheet_() : getSpreadsheet_();
}

function ticketChannelId_(context) {
  return isSupportContext_(context)
    ? getRequiredProperty_(CONFIG.SLACK_SUPPORT_CHANNEL_ID)
    : getRequiredProperty_(CONFIG.SLACK_TICKETS_CHANNEL_ID);
}

function reportChannelId_(context) {
  if (isSupportContext_(context)) {
    return getProperty_(CONFIG.SLACK_SUPPORT_REPORT_CHANNEL_ID, '') || getRequiredProperty_(CONFIG.SLACK_SUPPORT_CHANNEL_ID);
  }

  return getProperty_(CONFIG.SLACK_REPORT_CHANNEL_ID, '') || getRequiredProperty_(CONFIG.SLACK_TICKETS_CHANNEL_ID);
}

function ticketReportTitle_(context, baseTitle) {
  return isSupportContext_(context) ? baseTitle + ' техподдержки' : baseTitle;
}

function handleSlashCommand_(request) {
  if (request.command === '/support') {
    if (!shouldOpenModalDirectly_()) {
      return jsonOutput_({
        response_type: 'ephemeral',
        text: 'Команда /support должна идти через быстрый Slack relay. Поставьте Worker URL в Slash Commands.',
      });
    }

    openSupportTicketModal_(request.triggerId);

    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Открываю форму создания тикета техподдержки.',
    });
  }

  if (request.command === '/support-report') {
    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Команда /support-report должна идти через быстрый Slack relay. Поставьте Worker URL в Slash Commands.',
    });
  }

  if (request.command === '/add') {
    if (!isAdmin_(request.userId)) {
      return jsonOutput_({
        response_type: 'ephemeral',
        text: outsideTaskAccessDeniedText_(),
      });
    }

    if (shouldOpenModalDirectly_()) {
      openOutsideTaskModal_(request.triggerId);

      return jsonOutput_({
        response_type: 'ephemeral',
        text: 'Открываю форму добавления вне Slack задач.',
      });
    }

    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Команда /add должна идти через быстрый Slack relay. Поставьте Worker URL в Slash Commands.',
    });
  }

  if (request.command === '/report') {
    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Команда /report должна идти через быстрый Slack relay. Поставьте Worker URL в Slash Commands.',
    });
  }

  if (request.command && request.command !== '/ticket') {
    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Эта автоматизация обрабатывает команды /ticket, /support, /add, /report и /support-report.',
    });
  }

  if (!shouldOpenModalDirectly_()) {
    return jsonOutput_({
      response_type: 'ephemeral',
      text: 'Команда /ticket должна идти через быстрый Slack relay, а не напрямую в Apps Script. Поставьте Worker URL в Slack Request URL.',
    });
  }

  openTicketModal_(request.triggerId);

  return jsonOutput_({
    response_type: 'ephemeral',
    text: 'Открываю форму создания тикета.',
  });
}

function handleSlackPayload_(payload) {
  if (payload.type === 'shortcut' && payload.callback_id === CALLBACKS.shortcut) {
    if (!shouldOpenModalDirectly_()) {
      return jsonOutput_({});
    }

    openTicketModal_(payload.trigger_id);
    return jsonOutput_({});
  }

  if (payload.type === 'block_suggestion' && payload.action_id === ACTIONS.type) {
    return ticketTypeOptionsResponse_(payload);
  }

  if (payload.type === 'view_submission' && payload.view.callback_id === CALLBACKS.modal) {
    return handleTicketModalSubmission_(payload);
  }

  if (payload.type === 'view_submission' && payload.view.callback_id === CALLBACKS.outsideTaskModal) {
    return handleOutsideTaskModalSubmission_(payload);
  }

  if (payload.type === 'view_submission' && payload.view.callback_id === CALLBACKS.rejectModal) {
    return handleRejectModalSubmission_(payload);
  }

  if (payload.type === 'report_command') {
    handleReportCommand_(payload, TICKET_CONTEXTS.admin);
    return jsonOutput_({});
  }

  if (payload.type === 'support_report_command') {
    handleReportCommand_(payload, TICKET_CONTEXTS.support);
    return jsonOutput_({});
  }

  if (payload.type === 'block_actions') {
    return handleTicketAction_(payload);
  }

  return jsonOutput_({});
}

function processQueuesAfterPayload_(payload) {
  if (!payload) {
    return;
  }

  if (payload.type === 'view_submission' && payload.view && payload.view.callback_id === CALLBACKS.modal) {
    processPendingTickets();
    return;
  }

  if (payload.type === 'view_submission' && payload.view && payload.view.callback_id === CALLBACKS.rejectModal) {
    processPendingActions();
    return;
  }

  if (payload.type === 'block_actions') {
    const action = payload.actions && payload.actions[0];

    if (action && [CALLBACKS.take, CALLBACKS.done].indexOf(action.action_id) !== -1) {
      processPendingActions();
    }
  }
}

function handleTicketModalSubmission_(payload) {
  const context = ticketContextFromView_(payload.view);
  const form = isSupportContext_(context)
    ? extractSupportTicketForm_(payload.view.state.values)
    : extractTicketForm_(payload.view.state.values);
  const validationErrors = validateTicketForm_(form);

  if (Object.keys(validationErrors).length > 0) {
    return jsonOutput_({
      response_action: 'errors',
      errors: validationErrors,
    });
  }

  enqueueTicketSubmission_(payload, sanitizeTicketForm_(form), context);

  return jsonOutput_({
    response_action: 'clear',
  });
}

function handleOutsideTaskModalSubmission_(payload) {
  if (!isAdmin_(payload.user && payload.user.id)) {
    return jsonOutput_({
      response_action: 'errors',
      errors: {
        [BLOCKS.outsideTaskDetails]: outsideTaskAccessDeniedText_(),
      },
    });
  }

  const form = extractOutsideTaskForm_(payload.view.state.values);
  const validationErrors = validateOutsideTaskForm_(form);

  if (Object.keys(validationErrors).length > 0) {
    return jsonOutput_({
      response_action: 'errors',
      errors: validationErrors,
    });
  }

  const dedupeKey = outsideTaskSubmissionDedupeKey_(payload);

  if (dedupeKey && !tryRegisterDedupeKey_(dedupeKey, 21600)) {
    return jsonOutput_({
      response_action: 'clear',
    });
  }

  appendOutsideTask_(outsideTaskFromSubmission_(payload, form));
  safeRefreshOutsideTaskAnalyticsSheet_();

  return jsonOutput_({
    response_action: 'clear',
  });
}

function ticketTypeOptionsResponse_(payload) {
  return jsonOutput_({
    options: getTicketTypeOptions_(payload.value || ''),
  });
}

function outsideTaskSubmissionDedupeKey_(payload) {
  const viewId = payload && payload.view && payload.view.id;

  return viewId ? 'DEDUP_OUTSIDE_TASK_SUBMISSION_' + viewId : '';
}

function outsideTaskAccessDeniedText_() {
  return 'У вас нет прав на добавление вне Slack задач.';
}

function handleRejectModalSubmission_(payload) {
  const reason = sanitizeRejectionReason_(readModalText_(payload.view.state.values, BLOCKS.rejectReason, ACTIONS.rejectReason));

  if (!reason) {
    return jsonOutput_({
      response_action: 'errors',
      errors: {
        [BLOCKS.rejectReason]: 'Укажите причину отказа.',
      },
    });
  }

  const metadata = parseRejectModalMetadata_(payload.view.private_metadata);
  enqueueRejectTicketAction_(payload, metadata, reason);

  return jsonOutput_({
    response_action: 'clear',
  });
}

function handleTicketAction_(payload) {
  const action = payload.actions && payload.actions[0];
  const actionValue = action ? parseTicketActionValue_(action.value) : {};

  if (!action || !actionValue.ticketId) {
    return actionWarningResponse_(payload, 'Не удалось определить тикет для действия.');
  }

  if (!isAdmin_(payload.user.id, actionValue.context)) {
    return actionWarningResponse_(payload, 'У вас нет прав на это действие.');
  }

  if (action.action_id === CALLBACKS.reject) {
    const warning = assigneeActionWarningFromValue_(payload.user.id, actionValue);

    if (warning) {
      return actionWarningResponse_(payload, warning);
    }

    openRejectModal_(payload, actionValue.ticketId, actionValue.context);
    return jsonOutput_({});
  }

  if (action.action_id === CALLBACKS.done) {
    const warning = assigneeActionWarningFromValue_(payload.user.id, actionValue);

    if (warning) {
      return actionWarningResponse_(payload, warning);
    }

    enqueueTicketAction_(payload, action, actionValue);
    return jsonOutput_({});
  }

  if (action.action_id === CALLBACKS.take) {
    enqueueTicketAction_(payload, action, actionValue);
    return jsonOutput_({});
  }

  return jsonOutput_({});
}

function enqueueTicketSubmission_(payload, form, context) {
  const ticketContext = normalizeTicketContext_(context);
  const dedupeKey = ticketSubmissionDedupeKey_(payload);

  if (dedupeKey && !tryRegisterDedupeKey_(dedupeKey, 21600)) {
    return {
      duplicate: true,
    };
  }

  const createdAt = new Date();
  const queueId = 'ticket_' + Utilities.getUuid();
  const item = {
    queueId,
    context: ticketContext,
    ticketId: nextCompactTicketId_(ticketContext),
    attempts: 0,
    createdAt: createdAt.toISOString(),
    authorId: payload.user.id,
    authorName: payload.user.username || payload.user.name || payload.user.id,
    type: form.type,
    region: form.region,
    priority: form.priority,
    details: form.details,
    files: form.files || [],
    redactedFields: form.redactedFields || [],
    privacyNoticeRequired: Boolean(form.privacyNoticeRequired),
    sourceViewId: payload.view && payload.view.id,
  };

  saveQueueItem_(QUEUE.ticketPrefix, item.queueId, item);

  return item;
}

function ticketSubmissionDedupeKey_(payload) {
  const viewId = payload && payload.view && payload.view.id;

  return viewId ? 'DEDUP_TICKET_SUBMISSION_' + viewId : '';
}

function nextCompactTicketId_(context) {
  const config = ticketSequenceConfig_(context);

  return withScriptLock_(function () {
    const properties = PropertiesService.getScriptProperties();
    const storedValue = Number(properties.getProperty(config.key) || '0');
    const nextValue = (storedValue > 0 ? storedValue : maxCompactTicketNumber_(context)) + 1;

    properties.setProperty(config.key, String(nextValue));

    return config.prefix + nextValue;
  });
}

function primeTicketIdSequence_(context) {
  const config = ticketSequenceConfig_(context);

  return withScriptLock_(function () {
    const properties = PropertiesService.getScriptProperties();
    const storedValue = Number(properties.getProperty(config.key) || '0');
    const existingMax = maxCompactTicketNumber_(context);

    if (existingMax > storedValue) {
      properties.setProperty(config.key, String(existingMax));
    }

    return Math.max(storedValue, existingMax);
  });
}

function maxCompactTicketNumber_(context) {
  const config = ticketSequenceConfig_(context);
  const sheet = ensureTicketsSheet_(false, context);

  if (sheet.getLastRow() < 2) {
    return 0;
  }

  const headerMap = getHeaderMap_(sheet);
  const idColumn = headerMap['Ticket ID'];

  if (!idColumn) {
    return 0;
  }

  const values = sheet.getRange(2, idColumn, sheet.getLastRow() - 1, 1).getValues();

  return values.reduce(function (maxValue, row) {
    const match = String(row[0] || '').match(config.pattern);

    if (!match) {
      return maxValue;
    }

    return Math.max(maxValue, Number(match[1]));
  }, 0);
}

function ticketSequenceConfig_(context) {
  if (isSupportContext_(context)) {
    return {
      key: SUPPORT_TICKET_ID_SEQUENCE_KEY,
      prefix: 'TS',
      pattern: /^TS(\d+)$/i,
    };
  }

  return {
    key: TICKET_ID_SEQUENCE_KEY,
    prefix: 'T',
    pattern: /^T(\d+)$/i,
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
        ticketId: normalizeText_(parsed.ticketId),
        assigneeId: normalizeText_(parsed.assigneeId),
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

function ticketActionValue_(ticket) {
  return JSON.stringify({
    ticketId: ticket.id,
    assigneeId: ticket.assigneeId || '',
    context: normalizeTicketContext_(ticket.context),
  });
}

function assigneeActionWarningFromValue_(actorId, actionValue) {
  if (!actionValue.assigneeId || sameSlackUser_(actorId, actionValue.assigneeId)) {
    return '';
  }

  return assigneeOnlyWarning_(actionValue.assigneeId, actionValue.context);
}

function sameSlackUser_(left, right) {
  return normalizeText_(left).toUpperCase() === normalizeText_(right).toUpperCase();
}

function assigneeOnlyWarning_(assigneeId, context) {
  if (!assigneeId) {
    return 'Этот тикет еще не закреплен за исполнителем. Сначала нужно взять его в работу.';
  }

  const role = isSupportContext_(context) ? 'тех саппорт лид' : 'администратор';
  return 'Этот тикет взял в работу <@' + assigneeId + '>. Завершить или отклонить его может только этот ' + role + '.';
}

function enqueueTicketAction_(payload, action, actionValue) {
  const parsedValue = actionValue || parseTicketActionValue_(action.value);
  const context = normalizeTicketContext_(parsedValue.context);
  const dedupeKey = ticketActionDedupeKey_(payload, action.action_id, parsedValue.ticketId, context);

  if (dedupeKey && !tryRegisterDedupeKey_(dedupeKey, 300)) {
    return {
      duplicate: true,
    };
  }

  const item = {
    queueId: 'action_' + Utilities.getUuid(),
    attempts: 0,
    actionId: action.action_id,
    context,
    ticketId: parsedValue.ticketId,
    actorId: payload.user.id,
    actorName: payload.user.username || payload.user.name || payload.user.id,
    channelId: actionChannelId_(payload),
    messageTs: actionMessageTs_(payload),
    queuedAt: new Date().toISOString(),
  };

  saveQueueItem_(QUEUE.actionPrefix, item.queueId, item);

  return item;
}

function ticketActionDedupeKey_(payload, actionId, ticketId, context) {
  const actorId = payload && payload.user && payload.user.id;
  const messageTs = actionMessageTs_(payload);

  if (!actorId || !actionId || !ticketId || !messageTs) {
    return '';
  }

  return [
    'DEDUP_TICKET_ACTION',
    normalizeTicketContext_(context),
    actionId,
    ticketId,
    actorId,
    messageTs,
  ].join('_');
}

function enqueueRejectTicketAction_(payload, metadata, reason) {
  const dedupeKey = rejectSubmissionDedupeKey_(payload, metadata);

  if (dedupeKey && !tryRegisterDedupeKey_(dedupeKey, 300)) {
    return {
      duplicate: true,
    };
  }

  const item = {
    queueId: 'action_' + Utilities.getUuid(),
    attempts: 0,
    actionId: CALLBACKS.reject,
    context: normalizeTicketContext_(metadata.context || ticketContextFromId_(metadata.ticketId)),
    ticketId: metadata.ticketId,
    actorId: payload.user.id,
    actorName: payload.user.username || payload.user.name || payload.user.id,
    channelId: metadata.channelId,
    messageTs: metadata.messageTs,
    rejectionReason: reason,
    queuedAt: new Date().toISOString(),
  };

  saveQueueItem_(QUEUE.actionPrefix, item.queueId, item);

  return item;
}

function rejectSubmissionDedupeKey_(payload, metadata) {
  const viewId = payload && payload.view && payload.view.id;

  if (viewId) {
    return 'DEDUP_REJECT_SUBMISSION_' + viewId;
  }

  return metadata && metadata.ticketId ? 'DEDUP_REJECT_SUBMISSION_' + metadata.ticketId + '_' + (payload.user && payload.user.id || '') : '';
}

function tryRegisterDedupeKey_(key, ttlSeconds) {
  return withScriptLock_(function () {
    const cache = CacheService.getScriptCache();

    if (cache.get(key)) {
      return false;
    }

    cache.put(key, '1', ttlSeconds);

    return true;
  });
}

function processPendingTickets() {
  processQueue_(QUEUE.ticketIds, QUEUE.ticketPrefix, QUEUE.ticketHandler, processQueuedTicket_);
}

function processPendingActions() {
  processQueue_(QUEUE.actionIds, QUEUE.actionPrefix, QUEUE.actionHandler, processQueuedAction_);
}

function processQueuedTicket_(item) {
  let ticket = ticketFromQueuedSubmission_(item);
  let record;
  let createdNow = false;
  const context = normalizeTicketContext_(item.context || ticket.context);

  try {
    record = getTicketRecord_(ticket.id, context);
    const existing = record.ticket;
    ticket = Object.assign(ticket, existing, {
      files: existing.files && existing.files.length ? existing.files : ticket.files,
    });
  } catch (error) {
    record = appendTicket_(ticket);
    createdNow = true;
  }

  if (!ticket.slackMessageTs) {
    const message = postTicketCard_(ticket);
    const slackFields = {
      'Slack Channel': message.channel,
      'Slack Message TS': String(message.ts),
      'Slack Thread TS': String(message.ts),
    };

    updateTicketFields_(record.sheet, record.row, slackFields);
    ticket = Object.assign(ticket, {
      slackChannel: slackFields['Slack Channel'],
      slackMessageTs: slackFields['Slack Message TS'],
      slackThreadTs: slackFields['Slack Thread TS'],
    });
  }

  if (!isSupportContext_(context) && !ticket.responsibleNoticeSent) {
    const responsibleNotice = getTicketTypeResponsibleNotice_(ticket.type);

    if (responsibleNotice) {
      postTicketTypeResponsibleNoticeToThread_(ticket, responsibleNotice);
      const noticeSentAt = new Date();
      updateTicketFields_(record.sheet, record.row, {
        'Responsible Notice Sent': noticeSentAt,
      });
      ticket.responsibleNoticeSent = noticeSentAt;
      appendEvent_(ticket.id, 'Responsible Notified', responsibleNotice.userIds.join(', '), ticket.status, 'Automatic notification from ticket type settings', context);
    }
  }

  if (ticket.files && ticket.files.length && !ticket.filesPosted) {
    postAttachedFilesToThread_(ticket, ticket.files);
    const filesPostedAt = new Date();
    updateTicketFields_(record.sheet, record.row, {
      'Files Posted': filesPostedAt,
    });
    ticket.filesPosted = filesPostedAt;
  }

  if (ticket.privacyNoticeRequired && !ticket.privacyNoticeSent) {
    postPrivacyNoticeToThread_(ticket);
    const privacyNoticeSentAt = new Date();
    updateTicketFields_(record.sheet, record.row, {
      'Privacy Notice Sent': privacyNoticeSentAt,
    });
    ticket.privacyNoticeSent = privacyNoticeSentAt;
    appendPersonalDataAudit_(ticket, 'Ticket submitted with personal data');
    appendEvent_(ticket.id, 'Personal Data Redacted', ticket.authorId, ticket.status, 'Redacted fields: ' + ticket.redactedFields.join(', '), context);
  }

  if (createdNow) {
    appendEvent_(ticket.id, 'Created', ticket.authorId, 'New', 'Ticket submitted from Slack modal', context);
  }
}

function processQueuedAction_(item) {
  const payload = payloadFromQueuedAction_(item);
  const context = normalizeTicketContext_(item.context || ticketContextFromId_(item.ticketId));

  if (!isAdmin_(payload.user.id, context)) {
    postEphemeral_(payload, 'У вас нет прав на это действие.');
    return;
  }

  if (item.actionId === CALLBACKS.take) {
    takeTicket_(payload, item.ticketId, context);
    return;
  }

  if (item.actionId === CALLBACKS.done) {
    completeTicket_(payload, item.ticketId, context);
    return;
  }

  if (item.actionId === CALLBACKS.reject) {
    rejectTicket_(payload, item.ticketId, item.rejectionReason, context);
  }
}

function handleReportCommand_(payload, context) {
  const ticketContext = normalizeTicketContext_(context);
  const parsed = parseReportCommandText_(payload.text || '', isSupportContext_(ticketContext) ? '/support-report' : '/report');

  if (parsed.error) {
    respondToSlashCommand_(payload.response_url, {
      response_type: 'ephemeral',
      text: parsed.error,
    });
    return;
  }

  const report = buildReport_(parsed.startDate, parsed.endDate, parsed.admin, ticketReportTitle_(ticketContext, 'Отчет по тикетам'), ticketContext);
  writeReportSheet_(report);
  if (!isSupportContext_(ticketContext)) {
    safeWriteOutsideTaskAnalyticsSheet_(report);
  }

  respondToSlashCommand_(payload.response_url, reportSlackMessage_(report, 'ephemeral'));
}

function sendWeeklyReport() {
  const range = previousWeekRange_(new Date());
  const report = buildReport_(range.startDate, range.endDate, null, 'Еженедельный отчет по тикетам', TICKET_CONTEXTS.admin);

  writeReportSheet_(report);
  safeWriteOutsideTaskAnalyticsSheet_(report);
  postReportToChannel_(report);

  if (getProperty_(CONFIG.SLACK_SUPPORT_CHANNEL_ID, '')) {
    const supportReport = buildReport_(range.startDate, range.endDate, null, 'Еженедельный отчет по тикетам техподдержки', TICKET_CONTEXTS.support);
    writeReportSheet_(supportReport);
    postReportToChannel_(supportReport);
  }
}

function sendTicketReminders() {
  sendTicketRemindersForContext_(TICKET_CONTEXTS.admin);

  if (getProperty_(CONFIG.SLACK_SUPPORT_CHANNEL_ID, '')) {
    sendTicketRemindersForContext_(TICKET_CONTEXTS.support);
  }
}

function sendTicketRemindersForContext_(context) {
  const ticketContext = normalizeTicketContext_(context);
  const sheet = ensureTicketsSheet_(false, ticketContext);

  if (sheet.getLastRow() < 2) {
    return;
  }

  const headerMap = getHeaderMap_(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const now = new Date();

  rows.forEach(function (row, index) {
    const sheetRow = index + 2;
    let ticket = null;

    try {
      ticket = ticketFromRow_(row, headerMap, ticketContext);

      if (ticket.status === 'New' && !ticket.unacceptedReminderSent && hoursBetween_(ticket.createdAt, now) >= 72) {
        const adminId = randomActiveAdminId_(ticketContext);

        if (!adminId) {
          return;
        }

        postTicketReminder_(ticket, '<@' + adminId + '>, тикет ' + ticket.id + ' не взят в работу больше 3 дней. Пожалуйста, проверьте заявку и возьмите ее в работу или передайте ответственному ' + (isSupportContext_(ticketContext) ? 'тех саппорт лиду' : 'администратору') + '.');
        updateTicketFields_(sheet, sheetRow, {
          'Unaccepted Reminder Sent': now,
        });
        appendEvent_(ticket.id, 'Reminder Sent', adminId, ticket.status, 'Unaccepted for more than 3 days', ticketContext);
      }

      const inProgressSince = ticket.dateAccepted || ticket.createdAt;

      if (ticket.status === 'In Progress' && !ticket.inProgressReminderSent && ticket.assigneeId && inProgressSince && hoursBetween_(inProgressSince, now) >= 24) {
        postTicketReminder_(ticket, '<@' + ticket.assigneeId + '>, тикет ' + ticket.id + ' находится в работе больше 1 дня. Пожалуйста, обновите статус или завершите задачу.');
        updateTicketFields_(sheet, sheetRow, {
          'In Progress Reminder Sent': now,
        });
        appendEvent_(ticket.id, 'Reminder Sent', ticket.assigneeId, ticket.status, 'In progress for more than 1 day', ticketContext);
      }
    } catch (error) {
      safeAppendEvent_(
        ticket && ticket.id || String(getCell_(row, headerMap, 'Ticket ID') || ''),
        'Reminder Failed',
        ticket && ticket.assigneeId || '',
        ticket && ticket.status || '',
        friendlyError_(error),
        ticketContext
      );
    }
  });
}

function randomActiveAdminId_(context) {
  const activeIds = getActiveAdminIds_(context);
  const ids = activeIds.length ? activeIds : getAdminIdsFromProperties_(context);

  if (!ids.length) {
    return '';
  }

  return ids[Math.floor(Math.random() * ids.length)];
}

function refreshReportsSheet_() {
  const range = currentMonthRange_(new Date());
  const report = buildReport_(range.startDate, range.endDate, null, 'Отчет по тикетам за текущий месяц', TICKET_CONTEXTS.admin);
  writeReportSheet_(report);
  safeWriteOutsideTaskAnalyticsSheet_(report);
}

function refreshSupportReportsSheet_() {
  const range = currentMonthRange_(new Date());
  const report = buildReport_(range.startDate, range.endDate, null, 'Отчет по тикетам техподдержки за текущий месяц', TICKET_CONTEXTS.support);
  writeReportSheet_(report);
}

function parseReportCommandText_(text, commandName) {
  const tokens = normalizeText_(text).split(/\s+/).filter(Boolean);
  const command = commandName || '/report';
  let admin = null;

  if (tokens.length && isAdminReportToken_(tokens[0])) {
    admin = parseReportAdminToken_(tokens.shift());
  }

  if (tokens.length < 2) {
    return {
      error:
        'Укажите период отчета. Примеры: `' + command + ' 05.05.2026 06.05.2026` или `' + command + ' @admin 05.05.2026 06.05.2026`.',
    };
  }

  const startDate = parseReportDate_(tokens[0], false);
  const endDate = parseReportDate_(tokens[1], true);

  if (!startDate || !endDate) {
    return {
      error: 'Дата должна быть в формате `дд.мм.гггг`, например `' + command + ' 05.05.2026 06.05.2026`.',
    };
  }

  if (endDate.getTime() < startDate.getTime()) {
    return {
      error: 'Дата окончания не может быть раньше даты начала.',
    };
  }

  return {
    startDate,
    endDate,
    admin,
  };
}

function isAdminReportToken_(token) {
  return /^<@[^>]+>$/.test(token) || /^@[^\s]+$/.test(token);
}

function parseReportAdminToken_(token) {
  const mention = String(token || '').match(/^<@([A-Z0-9]+)(?:\|([^>]+))?>$/i);

  if (mention) {
    return {
      id: mention[1],
      name: mention[2] || mention[1],
      label: '<@' + mention[1] + '>',
      raw: token,
    };
  }

  const name = String(token || '').replace(/^@/, '');

  return {
    id: '',
    name,
    label: '@' + name,
    raw: token,
  };
}

function parseReportDate_(token, endOfDay) {
  const match = String(token || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}

function buildReport_(startDate, endDate, admin, title, context) {
  const ticketContext = normalizeTicketContext_(context);
  const allTickets = getAllTickets_(ticketContext);
  const allOutsideTasks = isSupportContext_(ticketContext) ? [] : getAllOutsideTasks_();
  const reportCutoff = reportCutoffDate_();
  const reportTickets = allTickets.filter(function (ticket) {
    return reportEligibleTicket_(ticket, reportCutoff);
  });
  const filteredTickets = admin ? reportTickets.filter(function (ticket) {
    return ticketMatchesAdmin_(ticket, admin);
  }) : reportTickets;
  const outsideTasks = allOutsideTasks.filter(function (task) {
    return (!reportCutoff || dateInRange_(task.timestamp, reportCutoff, endDate)) &&
      (!admin || outsideTaskMatchesAdmin_(task, admin)) &&
      dateInRange_(task.timestamp, startDate, endDate);
  });
  const createdTickets = filteredTickets.filter(function (ticket) {
    return dateInRange_(ticket.createdAt, startDate, endDate);
  });
  const acceptedTickets = filteredTickets.filter(function (ticket) {
    return dateInRange_(ticket.dateAccepted, startDate, endDate);
  });
  const completedTickets = filteredTickets.filter(function (ticket) {
    return ticket.status === 'Done' && dateInRange_(ticket.dateCompleted, startDate, endDate);
  });
  const rejectedTickets = filteredTickets.filter(function (ticket) {
    return ticket.status === 'Rejected' && dateInRange_(ticket.dateCompleted, startDate, endDate);
  });
  const inProgressCount = filteredTickets.filter(function (ticket) {
    return ticket.status === 'In Progress';
  }).length;
  const resolutionHours = completedTickets
    .map(function (ticket) {
      return ticketResolutionTimeHours_(ticket);
    })
    .filter(function (value) {
      return value > 0;
    });
  const reactionHours = acceptedTickets
    .map(function (ticket) {
      return numberOrFallback_(ticket.reactionTimeHours, ticket.dateAccepted ? hoursBetween_(ticket.createdAt, ticket.dateAccepted) : 0);
    })
    .filter(function (value) {
      return value >= 0;
    });
  const outsideTaskCount = sum_(outsideTasks.map(function (task) {
    return Number(task.count) || 0;
  }));

  return {
    title,
    context: ticketContext,
    startDate,
    endDate,
    admin,
    periodLabel: formatReportDate_(startDate) + ' - ' + formatReportDate_(endDate),
    generatedAt: new Date(),
    summary: {
      created: createdTickets.length,
      accepted: acceptedTickets.length,
      completed: completedTickets.length,
      rejected: rejectedTickets.length,
      inProgress: inProgressCount,
      avgResolutionHours: average_(resolutionHours),
      totalResolutionHours: sum_(resolutionHours),
      avgReactionHours: average_(reactionHours),
      outsideTasks: outsideTaskCount,
      outsideTaskEntries: outsideTasks.length,
    },
    byAdmin: groupTickets_(completedTickets, function (ticket) {
      return ticket.assigneeName || ticket.assigneeId || 'Без исполнителя';
    }),
    byType: groupTickets_(createdTickets, function (ticket) {
      return ticket.type || 'Не указано';
    }),
    byRegion: groupTickets_(createdTickets, function (ticket) {
      return ticket.region || 'Не указано';
    }),
    byStatus: groupTickets_(createdTickets, function (ticket) {
      return statusLabel_(ticket.status);
    }),
    outsideTasks,
    byOutsideAdmin: groupOutsideTasks_(outsideTasks, function (task) {
      return task.employeeName || task.employeeId || 'Без сотрудника';
    }),
  };
}

function getAllTickets_(context) {
  const sheet = ensureTicketsSheet_(false, context);

  if (sheet.getLastRow() < 2) {
    return [];
  }

  const headerMap = getHeaderMap_(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  return rows
    .filter(function (row) {
      return getCell_(row, headerMap, 'Ticket ID');
    })
    .map(function (row) {
      return ticketFromRow_(row, headerMap, context);
    });
}

function getAllOutsideTasks_() {
  const sheet = ensureOutsideTasksSheet_();

  if (sheet.getLastRow() < 2) {
    return [];
  }

  const headerMap = getHeaderMap_(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  return rows
    .filter(function (row) {
      return getCell_(row, headerMap, 'Timestamp');
    })
    .map(function (row) {
      return outsideTaskFromRow_(row, headerMap);
    });
}

function outsideTaskFromRow_(row, headerMap) {
  return {
    timestamp: asDate_(getCell_(row, headerMap, 'Timestamp')),
    employeeId: getCell_(row, headerMap, 'Employee'),
    employeeName: getCell_(row, headerMap, 'Employee Name'),
    count: Number(getCell_(row, headerMap, 'Task Count')) || 0,
    details: getCell_(row, headerMap, 'Details'),
    slackChannel: getCell_(row, headerMap, 'Slack Channel'),
  };
}

function ticketMatchesAdmin_(ticket, admin) {
  if (!admin) {
    return true;
  }

  if (admin.id && String(ticket.assigneeId || '').toUpperCase() === String(admin.id).toUpperCase()) {
    return true;
  }

  const expectedName = normalizeReportName_(admin.name || admin.raw);
  const assigneeName = normalizeReportName_(ticket.assigneeName);
  const assigneeId = normalizeReportName_(ticket.assigneeId);

  return Boolean(expectedName && (assigneeName === expectedName || assigneeId === expectedName));
}

function outsideTaskMatchesAdmin_(task, admin) {
  if (!admin) {
    return true;
  }

  if (admin.id && String(task.employeeId || '').toUpperCase() === String(admin.id).toUpperCase()) {
    return true;
  }

  const expectedName = normalizeReportName_(admin.name || admin.raw);
  const employeeName = normalizeReportName_(task.employeeName);
  const employeeId = normalizeReportName_(task.employeeId);

  return Boolean(expectedName && (employeeName === expectedName || employeeId === expectedName));
}

function getTicketTypeOptions_(query) {
  const normalizedQuery = normalizeReportName_(query);
  const rows = getTicketTypes_()
    .filter(function (type) {
      return !normalizedQuery || normalizeReportName_(type).indexOf(normalizedQuery) !== -1;
    })
    .slice(0, 100);

  return rows.map(ticketTypeOption_);
}

function getTicketTypes_() {
  const sheet = ensureTicketTypesSheet_();

  if (sheet.getLastRow() < 2) {
    return DEFAULT_TICKET_TYPES.slice();
  }

  const headerMap = getHeaderMap_(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const types = rows
    .map(function (row, index) {
      return {
        name: normalizeText_(getCell_(row, headerMap, 'Тип заявки')),
        active: getCell_(row, headerMap, 'Активен'),
        sort: Number(getCell_(row, headerMap, 'Порядок')) || index + 1,
      };
    })
    .filter(function (type) {
      return type.name && isActiveAdminValue_(type.active);
    })
    .sort(function (left, right) {
      return left.sort - right.sort || left.name.localeCompare(right.name);
    })
    .map(function (type) {
      return type.name;
    });

  return types.length ? types : DEFAULT_TICKET_TYPES.slice();
}

function getTicketTypeResponsibleNotice_(ticketType) {
  const expectedType = normalizeReportName_(ticketType);

  if (!expectedType) {
    return null;
  }

  const sheet = ensureTicketTypesSheet_();

  if (sheet.getLastRow() < 2) {
    return null;
  }

  const headerMap = getHeaderMap_(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const typeName = normalizeText_(getCell_(row, headerMap, 'Тип заявки'));

    if (normalizeReportName_(typeName) !== expectedType || !isActiveAdminValue_(getCell_(row, headerMap, 'Активен'))) {
      continue;
    }

    const userIds = parseResponsibleSlackUserIds_(getCell_(row, headerMap, 'Ответственный Slack ID'));

    if (!userIds.length) {
      return null;
    }

    const message = redactPersonalData_(
      normalizeText_(getCell_(row, headerMap, 'Сообщение в тред')) ||
        'Пожалуйста, подключитесь к выполнению этой заявки.'
    ).text;

    return {
      userIds,
      message,
    };
  }

  return null;
}

function parseResponsibleSlackUserIds_(value) {
  const matches = String(value || '').match(/U[A-Z0-9]{5,}/gi) || [];
  const unique = {};

  return matches
    .map(function (userId) {
      return userId.toUpperCase();
    })
    .filter(function (userId) {
      if (unique[userId]) {
        return false;
      }

      unique[userId] = true;
      return true;
    });
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

function normalizeReportName_(value) {
  return String(value || '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
}

function dateInRange_(value, startDate, endDate) {
  if (!value) {
    return false;
  }

  const date = asDateOrEmpty_(value);

  return Boolean(date) && date.getTime() >= startDate.getTime() && date.getTime() <= endDate.getTime();
}

function reportEligibleTicket_(ticket, cutoff) {
  if (!cutoff) {
    return true;
  }

  return Boolean(ticket && ticket.createdAt && asDate_(ticket.createdAt).getTime() >= cutoff.getTime());
}

function reportCutoffDate_() {
  let cutoff = getProperty_(CONFIG.REPORT_CUTOFF_AT, '');

  if (!cutoff) {
    ensureReportCutoff_();
    cutoff = getProperty_(CONFIG.REPORT_CUTOFF_AT, '');
  }

  const cutoffDate = asDateOrEmpty_(cutoff);

  return cutoffDate ? startOfDay_(cutoffDate) : '';
}

function ensureReportCutoff_() {
  const properties = PropertiesService.getScriptProperties();

  if (!properties.getProperty(CONFIG.REPORT_CUTOFF_AT)) {
    properties.setProperty(CONFIG.REPORT_CUTOFF_AT, startOfDay_(new Date()).toISOString());
  }
}

function startOfDay_(value) {
  const date = asDate_(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function numberOrFallback_(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ticketResolutionTimeHours_(ticket) {
  if (!ticket) {
    return '';
  }

  if (ticket.dateAccepted && ticket.dateCompleted) {
    return hoursBetween_(ticket.dateAccepted, ticket.dateCompleted);
  }

  if (ticket.resolutionTimeHours !== '' && ticket.resolutionTimeHours !== null && ticket.resolutionTimeHours !== undefined) {
    return Number(ticket.resolutionTimeHours);
  }

  if (ticket.createdAt && ticket.dateCompleted) {
    return hoursBetween_(ticket.createdAt, ticket.dateCompleted);
  }

  return '';
}

function groupTickets_(tickets, keyGetter) {
  const groups = {};

  tickets.forEach(function (ticket) {
    const key = normalizeText_(keyGetter(ticket)) || 'Не указано';
    groups[key] = (groups[key] || 0) + 1;
  });

  return Object.keys(groups)
    .map(function (key) {
      return {
        name: key,
        count: groups[key],
      };
    })
    .sort(function (left, right) {
      return right.count - left.count || left.name.localeCompare(right.name);
    });
}

function groupOutsideTasks_(tasks, keyGetter) {
  const groups = {};

  tasks.forEach(function (task) {
    const key = normalizeText_(keyGetter(task)) || 'Не указано';
    groups[key] = (groups[key] || 0) + (Number(task.count) || 0);
  });

  return Object.keys(groups)
    .map(function (key) {
      return {
        name: key,
        count: groups[key],
      };
    })
    .sort(function (left, right) {
      return right.count - left.count || left.name.localeCompare(right.name);
    });
}

function sum_(values) {
  return values.reduce(function (total, value) {
    return total + value;
  }, 0);
}

function average_(values) {
  return values.length ? sum_(values) / values.length : 0;
}

function reportSlackMessage_(report, responseType) {
  const title = report.admin ? report.title + ' · ' + report.admin.label : report.title;
  const topAdmins = report.byAdmin.slice(0, 8);
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncatePlainText_(title, 150),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            '*Период:* ' +
            escapeSlack_(report.periodLabel) +
            ' · *Сформировано:* ' +
            slackDate_(report.generatedAt),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        reportField_('Создано', String(report.summary.created)),
        reportField_('Взято в работу', String(report.summary.accepted)),
        reportField_('Выполнено', String(report.summary.completed)),
        reportField_('Отклонено', String(report.summary.rejected)),
        reportField_('В работе сейчас', String(report.summary.inProgress)),
        reportField_('Среднее выполнение', formatReportDuration_(report.summary.avgResolutionHours)),
        reportField_('Общее выполнение', formatReportDuration_(report.summary.totalResolutionHours)),
        reportField_('Средняя реакция', formatReportDuration_(report.summary.avgReactionHours)),
      ],
    },
  ];

  if (!report.admin) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: (isSupportContext_(report.context) ? '*Закрытые тикеты по тех саппорт лидам:*\n' : '*Закрытые тикеты по администраторам:*\n') + formatReportList_(topAdmins),
      },
    });
  }

  return {
    response_type: responseType || 'ephemeral',
    text: reportPlainText_(report),
    blocks,
  };
}

function reportField_(label, value) {
  return {
    type: 'mrkdwn',
    text: '*' + label + ':*\n' + value,
  };
}

function formatReportList_(items) {
  if (!items.length) {
    return 'Нет данных за выбранный период.';
  }

  return items
    .map(function (item) {
      return '• ' + escapeSlack_(item.name) + ': *' + item.count + '*';
    })
    .join('\n');
}

function formatOutsideTaskList_(tasks, includeEmployee) {
  return tasks
    .map(function (task) {
      const employee = includeEmployee ? '<@' + task.employeeId + '> · ' : '';
      return '• ' + employee + '*' + task.count + '* — ' + truncateSlackText_(escapeSlack_(task.details), 180);
    })
    .join('\n');
}

function reportPlainText_(report) {
  return (
    report.title +
    ' за период ' +
    report.periodLabel +
    ': выполнено ' +
    report.summary.completed +
    ', среднее время выполнения ' +
    formatReportDuration_(report.summary.avgResolutionHours) +
    ', общее время выполнения ' +
    formatReportDuration_(report.summary.totalResolutionHours) +
    '.'
  );
}

function respondToSlashCommand_(responseUrl, payload) {
  if (!responseUrl) {
    throw new Error('Slack не передал response_url для /report.');
  }

  const response = UrlFetchApp.fetch(responseUrl, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 300) {
    throw new Error('Не удалось отправить ответ /report: ' + response.getContentText());
  }
}

function postReportToChannel_(report) {
  const channel = reportChannelId_(report.context);
  const message = reportSlackMessage_(report, 'in_channel');
  delete message.response_type;

  return slackApi_('chat.postMessage', Object.assign(message, {
    channel,
    unfurl_links: false,
    unfurl_media: false,
  }));
}

function writeReportSheet_(report) {
  const spreadsheet = spreadsheetForContext_(report.context);
  const sheet = getOrCreateSheet_(spreadsheet, reportSheetName_(report.context));

  resetSheetForRewrite_(sheet);
  sheet.setFrozenRows(3);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor(isSupportContext_(report.context) ? '#0b8043' : '#1a73e8');

  sheet.getRange('A1:H1').merge();
  sheet.getRange('A1')
    .setValue(report.admin ? report.title + ' · ' + report.admin.label : report.title)
    .setFontWeight('bold')
    .setFontSize(18)
    .setFontColor('#ffffff')
    .setBackground('#183153')
    .setHorizontalAlignment('center');

  sheet.getRange('A2:H2').merge();
  sheet.getRange('A2')
    .setValue('Период: ' + report.periodLabel + ' · Сформировано: ' + formatReportDateTime_(report.generatedAt))
    .setFontColor('#183153')
    .setBackground('#e8f0fe')
    .setHorizontalAlignment('center');

  sheet.getRange('A4:H4').setValues([[
    'Создано',
    'Взято в работу',
    'Выполнено',
    'Отклонено',
    'В работе сейчас',
    'Среднее выполнение',
    'Общее выполнение',
    'Средняя реакция',
  ]]);
  sheet.getRange('A5:H5').setValues([[
    report.summary.created,
    report.summary.accepted,
    report.summary.completed,
    report.summary.rejected,
    report.summary.inProgress,
    formatReportDuration_(report.summary.avgResolutionHours),
    formatReportDuration_(report.summary.totalResolutionHours),
    formatReportDuration_(report.summary.avgReactionHours),
  ]]);
  sheet.getRange('A4:H4').setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a73e8').setHorizontalAlignment('center');
  sheet.getRange('A5:H5').setFontWeight('bold').setFontSize(13).setBackground('#f8fbff').setHorizontalAlignment('center');
  sheet.getRange('A4:H5').setBorder(true, true, true, true, true, true, '#d0d7de', SpreadsheetApp.BorderStyle.SOLID);

  let nextRow = 8;

  if (!report.admin) {
    const tableTitle = isSupportContext_(report.context) ? 'Закрытые тикеты по тех саппорт лидам' : 'Закрытые тикеты по администраторам';
    const firstColHeader = isSupportContext_(report.context) ? 'Тех саппорт лид' : 'Администратор';
    nextRow = writeReportTable_(sheet, nextRow, 1, tableTitle, [firstColHeader, 'Выполнено'], report.byAdmin);
  }

  nextRow = Math.max(nextRow, 8);
  if (!isSupportContext_(report.context)) {
    writeReportTable_(sheet, 8, 4, 'Типы заявок', ['Тип', 'Количество'], report.byType);
    writeReportTable_(sheet, 8, 7, 'Регионы / ОП', ['Регион / ОП', 'Количество'], report.byRegion);
  }
  nextRow = writeReportTable_(sheet, nextRow + 2, 1, 'Статусы созданных тикетов', ['Статус', 'Количество'], report.byStatus);

  sheet.autoResizeColumns(1, 8);
  sheet.setColumnWidths(1, 8, 145);
  insertReportCharts_(sheet, report);

  return sheet;
}

function writeReportTable_(sheet, row, column, title, headers, items) {
  const data = items.length ? items.map(function (item) {
    return [item.name, item.count];
  }) : [['Нет данных', 0]];
  const width = headers.length;

  sheet.getRange(row, column, 1, width).merge();
  sheet.getRange(row, column)
    .setValue(title)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#345995')
    .setHorizontalAlignment('center');
  sheet.getRange(row + 1, column, 1, width)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#dbe8ff');
  sheet.getRange(row + 2, column, data.length, width)
    .setValues(data)
    .setBackground('#ffffff');
  sheet.getRange(row, column, data.length + 2, width)
    .setBorder(true, true, true, true, true, true, '#d0d7de', SpreadsheetApp.BorderStyle.SOLID);

  return row + data.length + 3;
}

function writeOutsideTaskAnalyticsSheet_(report) {
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, SHEETS.outsideReport);
  const taskRows = report.outsideTasks
    .slice()
    .sort(function (left, right) {
      return asDate_(right.timestamp).getTime() - asDate_(left.timestamp).getTime();
    })
    .map(function (task) {
      return [
        task.timestamp,
        task.employeeName || task.employeeId || 'Не указано',
        task.employeeId,
        Number(task.count) || 0,
        task.details,
        task.slackChannel,
      ];
    });
  const employeeRows = report.byOutsideAdmin.length
    ? report.byOutsideAdmin.map(function (item) {
      return [item.name, item.count];
    })
    : [['Нет данных', 0]];
  const detailsRows = taskRows.length ? taskRows : [['Нет данных', '', '', '', '', '']];
  const totalTasks = Number(report.summary.outsideTasks) || 0;
  const entryCount = Number(report.summary.outsideTaskEntries) || 0;
  const averagePerEntry = entryCount ? totalTasks / entryCount : 0;

  resetSheetForRewrite_(sheet);
  sheet.setFrozenRows(8);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#fbbc04');

  sheet.getRange('A1:J1').merge();
  sheet.getRange('A1')
    .setValue(report.admin ? 'Вне Slack аналитика · ' + report.admin.label : 'Вне Slack аналитика')
    .setFontWeight('bold')
    .setFontSize(18)
    .setFontColor('#202124')
    .setBackground('#fce8b2')
    .setHorizontalAlignment('center');

  sheet.getRange('A2:J2').merge();
  sheet.getRange('A2')
    .setValue('Период: ' + report.periodLabel + ' · Сформировано: ' + formatReportDateTime_(report.generatedAt))
    .setFontColor('#5f4300')
    .setBackground('#fff7d6')
    .setHorizontalAlignment('center');

  sheet.getRange('A4:D4').setValues([[
    'Всего задач',
    'Записей',
    'Сотрудников',
    'Среднее на запись',
  ]]);
  sheet.getRange('A5:D5').setValues([[
    totalTasks,
    entryCount,
    report.byOutsideAdmin.length,
    averagePerEntry,
  ]]);
  sheet.getRange('A4:D4').setFontWeight('bold').setFontColor('#202124').setBackground('#fbbc04').setHorizontalAlignment('center');
  sheet.getRange('A5:D5').setFontWeight('bold').setFontSize(13).setBackground('#fffdf4').setHorizontalAlignment('center');
  sheet.getRange('A4:D5').setBorder(true, true, true, true, true, true, '#e3c367', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange('D5').setNumberFormat('0.00');

  sheet.getRange('A8:B8').merge();
  sheet.getRange('A8')
    .setValue('По сотрудникам')
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#8a6d1d')
    .setHorizontalAlignment('center');
  sheet.getRange('A9:B9')
    .setValues([['Сотрудник', 'Задач']])
    .setFontWeight('bold')
    .setBackground('#fff1bf');
  sheet.getRange(10, 1, employeeRows.length, 2)
    .setValues(employeeRows)
    .setBackground('#ffffff');
  sheet.getRange(8, 1, employeeRows.length + 2, 2)
    .setBorder(true, true, true, true, true, true, '#e3c367', SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange('D8:I8').merge();
  sheet.getRange('D8')
    .setValue('Список вне Slack задач')
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#8a6d1d')
    .setHorizontalAlignment('center');
  sheet.getRange('D9:I9')
    .setValues([['Дата', 'Сотрудник', 'Slack ID', 'Количество', 'Задачи', 'Slack Channel']])
    .setFontWeight('bold')
    .setBackground('#fff1bf');
  sheet.getRange(10, 4, detailsRows.length, 6)
    .setValues(detailsRows)
    .setBackground('#ffffff')
    .setVerticalAlignment('top');
  sheet.getRange(10, 4, detailsRows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(10, 8, detailsRows.length, 1).setNumberFormat('0');
  sheet.getRange(10, 8, detailsRows.length, 1).setHorizontalAlignment('center');
  sheet.getRange(10, 8, detailsRows.length, 2).setWrap(true);
  sheet.getRange(8, 4, detailsRows.length + 2, 6)
    .setBorder(true, true, true, true, true, true, '#e3c367', SpreadsheetApp.BorderStyle.SOLID);

  sheet.setColumnWidths(1, 1, 190);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(4, 150);
  sheet.setColumnWidth(5, 190);
  sheet.setColumnWidth(6, 120);
  sheet.setColumnWidth(7, 100);
  sheet.setColumnWidth(8, 95);
  sheet.setColumnWidth(9, 360);
  sheet.setColumnWidth(10, 130);

  if (report.byOutsideAdmin.length) {
    const chart = sheet
      .newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(9, 1, Math.min(report.byOutsideAdmin.length + 1, 12), 2))
      .setPosition(4, 6, 0, 0)
      .setOption('title', 'Вне Slack задачи по сотрудникам')
      .setOption('legend', { position: 'none' })
      .build();

    sheet.insertChart(chart);
  }

  return sheet;
}

function safeWriteOutsideTaskAnalyticsSheet_(report) {
  try {
    return writeOutsideTaskAnalyticsSheet_(report);
  } catch (error) {
    console.error(friendlyError_(error));
    safeAppendEvent_('', 'Outside Analytics Failed', '', '', friendlyError_(error));
    return null;
  }
}

function safeRefreshOutsideTaskAnalyticsSheet_() {
  try {
    const range = currentMonthRange_(new Date());
    const report = buildReport_(range.startDate, range.endDate, null, 'Отчет по тикетам за текущий месяц');
    writeOutsideTaskAnalyticsSheet_(report);
  } catch (error) {
    console.error(friendlyError_(error));
    safeAppendEvent_('', 'Outside Analytics Refresh Failed', '', '', friendlyError_(error));
  }
}

function resetSheetForRewrite_(sheet) {
  sheet.getCharts().forEach(function (chart) {
    sheet.removeChart(chart);
  });

  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
}

function insertReportCharts_(sheet, report) {
  if (report.byAdmin.length && !report.admin) {
    sheet.insertChart(
      sheet
        .newChart()
        .setChartType(Charts.ChartType.COLUMN)
        .addRange(sheet.getRange(9, 1, Math.min(report.byAdmin.length + 1, 12), 2))
        .setPosition(22, 1, 0, 0)
        .setOption('title', 'Выполнено по администраторам')
        .setOption('legend', { position: 'none' })
        .build()
    );
  }

  if (report.byType.length && !isSupportContext_(report.context)) {
    sheet.insertChart(
      sheet
        .newChart()
        .setChartType(Charts.ChartType.PIE)
        .addRange(sheet.getRange(9, 4, Math.min(report.byType.length + 1, 12), 2))
        .setPosition(22, 5, 0, 0)
        .setOption('title', 'Типы заявок')
        .build()
    );
  }
}

function currentMonthRange_(now) {
  const date = now || new Date();
  return {
    startDate: new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0),
    endDate: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999),
  };
}

function previousWeekRange_(now) {
  const date = now || new Date();
  const day = date.getDay() || 7;
  const thisMonday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - day + 1, 0, 0, 0, 0);
  const previousMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7, 0, 0, 0, 0);
  const previousSunday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 1, 23, 59, 59, 999);

  return {
    startDate: previousMonday,
    endDate: previousSunday,
  };
}

function formatReportDate_(date) {
  return Utilities.formatDate(asDate_(date), Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

function formatReportDateTime_(date) {
  return Utilities.formatDate(asDate_(date), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
}

function formatReportDuration_(hours) {
  const value = Number(hours);

  if (!Number.isFinite(value) || value <= 0) {
    return '0 мин';
  }

  return formatDuration_(value);
}

function ticketFromQueuedSubmission_(item) {
  const context = normalizeTicketContext_(item.context || ticketContextFromId_(item.ticketId));

  return {
    id: item.ticketId,
    context,
    createdAt: asDate_(item.createdAt),
    authorId: item.authorId,
    authorName: item.authorName,
    type: item.type,
    region: item.region,
    priority: item.priority,
    details: item.details,
    status: 'New',
    assigneeId: '',
    assigneeName: '',
    dateAccepted: '',
    reactionTimeHours: '',
    dateCompleted: '',
    resolutionTimeHours: '',
    slackChannel: ticketChannelId_(context),
    slackMessageTs: '',
    slackThreadTs: '',
    files: item.files || [],
    filesPosted: '',
    redactedFields: item.redactedFields || [],
    privacyNoticeRequired: Boolean(item.privacyNoticeRequired),
    privacyNoticeSent: '',
    responsibleNoticeSent: '',
  };
}

function payloadFromQueuedAction_(item) {
  return {
    user: {
      id: item.actorId,
      username: item.actorName,
      name: item.actorName,
    },
    channel: {
      id: item.channelId,
    },
    container: {
      channel_id: item.channelId,
      message_ts: item.messageTs,
    },
    message: {
      ts: item.messageTs,
    },
  };
}

function processQueue_(queueProperty, itemPrefix, handlerName, processor) {
  const ids = listQueueIds_(itemPrefix);

  ids.forEach(function (id) {
    const item = claimQueueItem_(itemPrefix, id);

    if (!item) {
      return;
    }

    try {
      processor(item);
      deleteQueueItem_(itemPrefix, id);
    } catch (error) {
      retryQueueItem_(queueProperty, itemPrefix, item, error);
    }
  });
}

function claimQueueItem_(prefix, id) {
  return withScriptLock_(function () {
    const item = loadQueueItem_(prefix, id);

    if (!item || isQueueItemProcessing_(item)) {
      return null;
    }

    item.processingAt = new Date().toISOString();
    saveQueueItem_(prefix, id, item);

    return item;
  });
}

function isQueueItemProcessing_(item) {
  if (!item.processingAt) {
    return false;
  }

  const startedAt = new Date(item.processingAt).getTime();

  return Number.isFinite(startedAt) && Date.now() - startedAt < QUEUE.processingTimeoutMs;
}

function retryQueueItem_(queueProperty, itemPrefix, item, error) {
  item.attempts = Number(item.attempts || 0) + 1;
  item.lastError = friendlyError_(error);
  delete item.processingAt;

  if (item.attempts >= QUEUE.retryLimit) {
    deleteQueueItem_(itemPrefix, item.queueId);
    safeAppendEvent_(item.ticketId || '', 'Queue Failed', item.actorId || item.authorId || '', '', item.lastError, item.context);
    return;
  }

  saveQueueItem_(itemPrefix, item.queueId, item);
}

function saveQueueItem_(prefix, id, item) {
  PropertiesService.getScriptProperties().setProperty(prefix + id, JSON.stringify(item));
}

function loadQueueItem_(prefix, id) {
  const raw = PropertiesService.getScriptProperties().getProperty(prefix + id);
  return raw ? JSON.parse(raw) : null;
}

function deleteQueueItem_(prefix, id) {
  PropertiesService.getScriptProperties().deleteProperty(prefix + id);
}

function listQueueIds_(prefix) {
  const properties = PropertiesService.getScriptProperties().getProperties();

  return Object.keys(properties)
    .filter(function (key) {
      return key.indexOf(prefix) === 0;
    })
    .map(function (key) {
      return key.slice(prefix.length);
    });
}

function installQueueTriggers_() {
  resetQueueTrigger_(QUEUE.ticketHandler);
  resetQueueTrigger_(QUEUE.actionHandler);
}

function installWeeklyReportTrigger_() {
  deleteQueueTriggers_(REPORTS.weeklyHandler);
  ScriptApp.newTrigger(REPORTS.weeklyHandler)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .nearMinute(0)
    .create();
}

function installReminderTrigger_() {
  deleteQueueTriggers_(REMINDERS.handler);
  ScriptApp.newTrigger(REMINDERS.handler).timeBased().everyHours(1).create();
}

function installTicketTypeSyncTrigger_() {
  deleteQueueTriggers_('handleTicketTypeSheetEdit');
  ScriptApp.newTrigger('handleTicketTypeSheetEdit')
    .forSpreadsheet(getSpreadsheet_())
    .onEdit()
    .create();
}

function handleTicketTypeSheetEdit(e) {
  const sheet = e && e.range && e.range.getSheet();

  if (!sheet || sheet.getName() !== SHEETS.ticketTypes) {
    return;
  }

  safeSyncTicketTypesToWorker_();
}

function safeSyncTicketTypesToWorker_() {
  try {
    syncTicketTypesToWorker_();
  } catch (error) {
    console.error(friendlyError_(error));
  }
}

function syncTicketTypesToWorker_() {
  const workerUrl = normalizeText_(getProperty_(CONFIG.WORKER_URL, ''));

  if (!workerUrl) {
    return;
  }

  const relaySecret = getProperty_(CONFIG.RELAY_SHARED_SECRET, '');

  if (!relaySecret) {
    console.error('WORKER_URL задан, но RELAY_SHARED_SECRET пустой. Кэш типов заявок в Worker не обновлен.');
    return;
  }

  const url = workerUrl.replace(/\/+$/, '') + '/ticket-types/cache?relay_secret=' + encodeURIComponent(relaySecret);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({
      options: getTicketTypeOptions_(''),
    }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 300) {
    throw new Error('Не удалось обновить кэш типов заявок в Worker: ' + response.getContentText());
  }
}

function resetQueueTrigger_(handlerName) {
  deleteQueueTriggers_(handlerName);
  ScriptApp.newTrigger(handlerName).timeBased().everyMinutes(1).create();
}

function deleteQueueTriggers_(handlerName) {
  ScriptApp
    .getProjectTriggers()
    .filter(function (trigger) {
      return trigger.getHandlerFunction() === handlerName;
    })
    .forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
}

function safeAppendEvent_(ticketId, event, actor, status, notes, context) {
  try {
    appendEvent_(ticketId, event, actor, status, notes, context);
  } catch (error) {
    console.error(friendlyError_(error));
  }
}

function actionChannelId_(payload) {
  const container = payload.container || {};
  const channel = (payload.channel && payload.channel.id) || container.channel_id;

  if (!channel) {
    throw new Error('Slack не передал channel_id для действия.');
  }

  return String(channel);
}

function actionMessageTs_(payload) {
  const container = payload.container || {};
  const message = payload.message || {};
  const ts = container.message_ts || message.thread_ts || message.ts;

  if (!ts) {
    throw new Error('Slack не передал message_ts для действия.');
  }

  return String(ts);
}

function takeTicket_(payload, ticketId, context) {
  const actor = payload.user;
  const now = new Date();
  const ticketContext = normalizeTicketContext_(context || ticketContextFromId_(ticketId));

  if (!isAdmin_(actor.id, ticketContext)) {
    return actionWarningResponse_(payload, 'У вас нет прав на это действие.');
  }

  const result = withScriptLock_(function () {
    const record = getTicketRecord_(ticketId, ticketContext);

    if (record.ticket.status !== 'New') {
      return {
        warning: 'Тикет уже не находится в статусе "Новая". Текущий статус: ' + statusLabel_(record.ticket.status) + '.',
      };
    }

    const reactionTime = hoursBetween_(record.ticket.createdAt, now);

    updateTicketFields_(record.sheet, record.row, {
      Status: 'In Progress',
      Assignee: actor.id,
      'Assignee Name': actor.username || actor.name || actor.id,
      'Date Accepted': now,
      'Reaction Time': reactionTime,
    });

    appendEvent_(ticketId, 'Taken', actor.id, 'In Progress', 'Ticket accepted by admin', ticketContext);

    return {
      ticket: getTicketRecord_(ticketId, ticketContext).ticket,
    };
  });

  if (result.warning) {
    return actionWarningResponse_(payload, result.warning);
  }

  updateTicketMessage_(payload, result.ticket);
  postThreadNotice_(
    payload,
    result.ticket,
    '<@' + result.ticket.authorId + '> ваша заявка принята в работу ' + (isSupportContext_(ticketContext) ? 'тех саппорт лидом' : 'администратором') + ' <@' + actor.id + '>. Дальнейшее общение ведем в этом треде.'
  );

  return jsonOutput_({});
}

function completeTicket_(payload, ticketId, context) {
  const actor = payload.user;
  const now = new Date();
  const ticketContext = normalizeTicketContext_(context || ticketContextFromId_(ticketId));

  if (!isAdmin_(actor.id, ticketContext)) {
    return actionWarningResponse_(payload, 'У вас нет прав на это действие.');
  }

  const result = withScriptLock_(function () {
    const record = getTicketRecord_(ticketId, ticketContext);

    if (record.ticket.status === 'Done') {
      return { warning: 'Тикет уже закрыт.' };
    }

    if (record.ticket.status === 'Rejected') {
      return { warning: 'Тикет уже отклонен.' };
    }

    if (record.ticket.status !== 'In Progress') {
      return { warning: 'Сначала тикет нужно взять в работу.' };
    }

    if (!sameSlackUser_(actor.id, record.ticket.assigneeId)) {
      return { warning: assigneeOnlyWarning_(record.ticket.assigneeId, ticketContext) };
    }

    const resolutionTime = hoursBetween_(record.ticket.dateAccepted || record.ticket.createdAt, now);

    updateTicketFields_(record.sheet, record.row, {
      Status: 'Done',
      'Date Completed': now,
      'Resolution Time': resolutionTime,
    });

    appendEvent_(ticketId, 'Completed', actor.id, 'Done', 'Ticket completed by admin', ticketContext);

    return {
      ticket: getTicketRecord_(ticketId, ticketContext).ticket,
    };
  });

  if (result.warning) {
    return actionWarningResponse_(payload, result.warning);
  }

  updateTicketMessage_(payload, result.ticket);
  postThreadNotice_(
    payload,
    result.ticket,
    '<@' + result.ticket.authorId + '> ваша заявка закрыта. Статус: выполнено.'
  );

  return jsonOutput_({});
}

function rejectTicket_(payload, ticketId, reason, context) {
  const actor = payload.user;
  const now = new Date();
  const ticketContext = normalizeTicketContext_(context || ticketContextFromId_(ticketId));
  const rejectionReason = sanitizeRejectionReason_(reason);

  if (!rejectionReason) {
    return actionWarningResponse_(payload, 'Укажите причину отказа.');
  }

  if (!isAdmin_(actor.id, ticketContext)) {
    return actionWarningResponse_(payload, 'У вас нет прав на это действие.');
  }

  const result = withScriptLock_(function () {
    const record = getTicketRecord_(ticketId, ticketContext);

    if (record.ticket.status === 'Done') {
      return { warning: 'Выполненный тикет нельзя отклонить.' };
    }

    if (record.ticket.status === 'Rejected') {
      return { warning: 'Тикет уже отклонен.' };
    }

    if (record.ticket.status !== 'In Progress') {
      return { warning: 'Сначала тикет нужно взять в работу.' };
    }

    if (!sameSlackUser_(actor.id, record.ticket.assigneeId)) {
      return { warning: assigneeOnlyWarning_(record.ticket.assigneeId, ticketContext) };
    }

    const resolutionTime = hoursBetween_(record.ticket.dateAccepted || record.ticket.createdAt, now);

    updateTicketFields_(record.sheet, record.row, {
      Status: 'Rejected',
      'Date Completed': now,
      'Resolution Time': resolutionTime,
      'Rejection Reason': rejectionReason,
    });

    appendEvent_(ticketId, 'Rejected', actor.id, 'Rejected', 'Reason: ' + rejectionReason, ticketContext);

    return {
      ticket: getTicketRecord_(ticketId, ticketContext).ticket,
    };
  });

  if (result.warning) {
    return actionWarningResponse_(payload, result.warning);
  }

  updateTicketMessage_(payload, result.ticket);
  postThreadNotice_(
    payload,
    result.ticket,
    '<@' + result.ticket.authorId + '> ваша заявка отклонена ' + (isSupportContext_(ticketContext) ? 'тех саппорт лидом' : 'администратором') + ' <@' + actor.id + '>.\n*Причина:* ' + escapeSlack_(rejectionReason)
  );

  return jsonOutput_({});
}

function parseSlackRequest_(e) {
  const params = (e && e.parameter) || {};

  if (params.payload) {
    return {
      kind: 'payload',
      token: '',
      relaySecret: params.relay_secret || '',
      payload: JSON.parse(params.payload),
    };
  }

  if (params.command || params.trigger_id) {
    return {
      kind: 'slash_command',
      token: params.token || '',
      relaySecret: params.relay_secret || '',
      command: params.command || '',
      triggerId: params.trigger_id || '',
      userId: params.user_id || '',
      channelId: params.channel_id || '',
      text: params.text || '',
      responseUrl: params.response_url || '',
    };
  }

  if (e && e.postData && e.postData.contents && String(e.postData.type || '').indexOf('application/json') === 0) {
    return {
      kind: 'payload',
      token: '',
      relaySecret: params.relay_secret || '',
      payload: JSON.parse(e.postData.contents),
    };
  }

  return {
    kind: 'unknown',
    token: params.token || '',
    relaySecret: params.relay_secret || '',
    payload: null,
  };
}

function isVerifiedSlackRequest_(request) {
  const expectedRelaySecret = getProperty_(CONFIG.RELAY_SHARED_SECRET, '');

  if (expectedRelaySecret) {
    return request.relaySecret === expectedRelaySecret;
  }

  const expectedToken = getProperty_(CONFIG.SLACK_VERIFICATION_TOKEN, '');

  if (!expectedToken) {
    return true;
  }

  if (request.kind === 'slash_command') {
    return request.token === expectedToken;
  }

  if (request.kind === 'payload' && request.payload && request.payload.token) {
    return request.payload.token === expectedToken;
  }

  return false;
}

function shouldOpenModalDirectly_() {
  return String(getProperty_(CONFIG.DIRECT_MODAL_OPENING, '')).toLowerCase() === 'true';
}

function openTicketModal_(triggerId) {
  if (!triggerId) {
    throw new Error('Slack не передал trigger_id для открытия формы.');
  }

  slackApi_('views.open', {
    trigger_id: triggerId,
    view: buildTicketModal_(),
  });
}

function openSupportTicketModal_(triggerId) {
  if (!triggerId) {
    throw new Error('Slack не передал trigger_id для открытия формы техподдержки.');
  }

  slackApi_('views.open', {
    trigger_id: triggerId,
    view: buildSupportTicketModal_(),
  });
}

function openOutsideTaskModal_(triggerId) {
  if (!triggerId) {
    throw new Error('Slack не передал trigger_id для открытия формы вне Slack задач.');
  }

  slackApi_('views.open', {
    trigger_id: triggerId,
    view: buildOutsideTaskModal_(),
  });
}

function openRejectModal_(payload, ticketId, context) {
  if (!payload.trigger_id) {
    throw new Error('Slack не передал trigger_id для окна причины отказа.');
  }

  const ref = slackMessageRef_(payload, {
    slackChannel: actionChannelId_(payload),
    slackMessageTs: actionMessageTs_(payload),
  });

  slackApi_('views.open', {
    trigger_id: payload.trigger_id,
    view: buildRejectModal_(ticketId, ref.channel, ref.ts, context),
  });
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
          options: Array.from({ length: 30 }, function (_, index) {
            return outsideTaskCountOption_(index + 1);
          }),
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

function extractTicketForm_(values) {
  return {
    type: readModalSelectText_(values, BLOCKS.type, ACTIONS.type),
    region: readModalText_(values, BLOCKS.region, ACTIONS.region),
    priority: readModalSelectText_(values, BLOCKS.priority, ACTIONS.priority),
    details: readModalText_(values, BLOCKS.details, ACTIONS.details),
    files: readModalFiles_(values, BLOCKS.files, ACTIONS.files),
  };
}

function extractSupportTicketForm_(values) {
  return {
    type: SUPPORT_TICKET_TYPE,
    region: readModalText_(values, BLOCKS.region, ACTIONS.region),
    priority: readModalSelectText_(values, BLOCKS.priority, ACTIONS.priority),
    details: readModalText_(values, BLOCKS.details, ACTIONS.details),
    files: readModalFiles_(values, BLOCKS.files, ACTIONS.files),
  };
}

function extractOutsideTaskForm_(values) {
  return {
    count: readModalSelectValue_(values, BLOCKS.outsideTaskCount, ACTIONS.outsideTaskCount),
    details: readModalText_(values, BLOCKS.outsideTaskDetails, ACTIONS.outsideTaskDetails),
  };
}

function validateTicketForm_(form) {
  const errors = {};

  if (!form.type) {
    errors[BLOCKS.type] = 'Укажите тип заявки.';
  }

  if (!form.region) {
    errors[BLOCKS.region] = 'Укажите регион, ОП или ID клиники.';
  }

  if (!form.priority) {
    errors[BLOCKS.priority] = 'Выберите приоритет.';
  }

  if (!form.details) {
    errors[BLOCKS.details] = 'Опишите задачу.';
  }

  return errors;
}

function validateOutsideTaskForm_(form) {
  const errors = {};
  const count = Number(form.count);

  if (!Number.isFinite(count) || count < 1) {
    errors[BLOCKS.outsideTaskCount] = 'Выберите количество задач.';
  }

  if (!form.details) {
    errors[BLOCKS.outsideTaskDetails] = 'Опишите выполненные вне Slack задачи.';
  }

  return errors;
}

function readModalText_(values, blockId, actionId) {
  const action = values[blockId] && values[blockId][actionId];
  return normalizeText_(action && action.value);
}

function readModalSelectText_(values, blockId, actionId) {
  const action = values[blockId] && values[blockId][actionId];
  const option = action && action.selected_option;

  if (!option) {
    return '';
  }

  return normalizeText_(option.text && option.text.text);
}

function readModalSelectValue_(values, blockId, actionId) {
  const action = values[blockId] && values[blockId][actionId];
  const option = action && action.selected_option;

  return normalizeText_(option && option.value);
}

function readModalFiles_(values, blockId, actionId) {
  const action = values[blockId] && values[blockId][actionId];
  const files = (action && action.files) || [];

  return files
    .map(function (file) {
      return {
        id: normalizeText_(file.id),
        name: normalizeText_(file.name),
        title: normalizeText_(file.title || file.name),
        mimetype: normalizeText_(file.mimetype),
        filetype: normalizeText_(file.filetype),
      };
    })
    .filter(function (file) {
      return file.id;
    });
}

function parseRejectModalMetadata_(value) {
  const metadata = JSON.parse(value || '{}');

  if (!metadata.ticketId || !metadata.channelId || !metadata.messageTs) {
    throw new Error('Не удалось определить тикет для отказа.');
  }

  return Object.assign(metadata, {
    context: normalizeTicketContext_(metadata.context || ticketContextFromId_(metadata.ticketId)),
  });
}

function sanitizeRejectionReason_(value) {
  return redactPersonalData_(value).text;
}

function sanitizeTicketForm_(form) {
  const redactedFields = [];
  const sanitized = Object.assign({}, form);

  [
    { key: 'type', label: 'Тип заявки' },
    { key: 'region', label: 'Регион / ОП / ID клиники' },
    { key: 'details', label: 'Детали задачи' },
  ].forEach(function (field) {
    const result = redactPersonalData_(sanitized[field.key]);
    sanitized[field.key] = result.text;

    if (result.redacted) {
      redactedFields.push(field.label);
    }
  });

  sanitized.redactedFields = redactedFields;
  sanitized.privacyNoticeRequired = redactedFields.length > 0;

  return sanitized;
}

function redactPersonalData_(value) {
  let text = normalizeText_(value);
  let redacted = false;
  const replacement = '[персональные данные удалены]';

  let result = replacePersonalDataPattern_(
    text,
    /(^|[^\d])((?:\d[\s-]?){14})(?=$|[^\d])/g,
    replacement,
    function (match) {
      return countDigits_(match) === 14;
    }
  );
  text = result.text;
  redacted = redacted || result.redacted;

  result = replacePersonalDataPattern_(
    text,
    /(^|[^\d])(\+?\s*998(?:[\s().-]*\d){9})(?=$|[^\d])/g,
    replacement,
    function (match) {
      return countDigits_(match) === 12;
    }
  );
  text = result.text;
  redacted = redacted || result.redacted;

  result = replacePersonalDataPattern_(
    text,
    /(^|[^\d+])(\(?\d{2}\)?[\s.-]+\d{3}[\s.-]+\d{2}[\s.-]+\d{2})(?=$|[^\d])/g,
    replacement,
    function (match) {
      return countDigits_(match) === 9;
    }
  );
  text = result.text;
  redacted = redacted || result.redacted;

  result = replacePersonalDataPattern_(
    text,
    /(^|[^A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u04510-9])([A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u0451]{2}\s*(?:\u2116|N|No\.?|#)?\s*[-:]?\s*(?:\d[\s-]?){7})(?=$|[^A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u04510-9])/gi,
    replacement,
    function (match) {
      return countLetters_(match) === 2 && countDigits_(match) === 7;
    }
  );
  text = result.text;
  redacted = redacted || result.redacted;

  result = replacePersonalDataPattern_(
    text,
    /(^|[^A-Za-z0-9])((?:I\s*[- ]?\s*TN|ITN)\s*[-:]?\s*(?:\d[\s-]?){6})(?=$|[^A-Za-z0-9])/gi,
    replacement,
    function (match) {
      return countDigits_(match) === 6;
    }
  );
  text = result.text;
  redacted = redacted || result.redacted;

  text = text
    .replace(new RegExp('(\\s*' + escapeRegExp_(replacement) + '\\s*){2,}', 'g'), ' ' + replacement + ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  if (!text) {
    text = replacement;
  }

  return {
    text,
    redacted,
  };
}

function replacePersonalDataPattern_(text, pattern, replacement, validator) {
  let redacted = false;
  const updatedText = String(text || '').replace(pattern, function (fullMatch, prefix, sensitiveValue) {
    if (!validator(sensitiveValue)) {
      return fullMatch;
    }

    redacted = true;
    return prefix + replacement;
  });

  return {
    text: updatedText,
    redacted,
  };
}

function countDigits_(value) {
  return (String(value || '').match(/\d/g) || []).length;
}

function countLetters_(value) {
  return (String(value || '').match(/[A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u0451]/g) || []).length;
}

function escapeRegExp_(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function postTicketCard_(ticket) {
  return slackApi_('chat.postMessage', {
    channel: ticket.slackChannel,
    text: ticketFallbackText_(ticket),
    attachments: [buildTicketAttachment_(ticket)],
    unfurl_links: false,
    unfurl_media: false,
  });
}

function updateTicketMessage_(payload, ticket) {
  const ref = slackMessageRef_(payload, ticket);

  return slackApi_('chat.update', {
    channel: ref.channel,
    ts: ref.ts,
    text: ticketFallbackText_(ticket),
    attachments: [buildTicketAttachment_(ticket)],
    unfurl_links: false,
    unfurl_media: false,
  });
}

function postThreadNotice_(payload, ticket, text) {
  const ref = slackMessageRef_(payload, ticket);

  return slackApi_('chat.postMessage', {
    channel: ref.channel,
    thread_ts: ref.ts,
    text,
    reply_broadcast: false,
    unfurl_links: false,
    unfurl_media: false,
  });
}

function postTicketReminder_(ticket, text) {
  const channel = String(ticket.slackChannel || getRequiredProperty_(CONFIG.SLACK_TICKETS_CHANNEL_ID));
  const threadTs = String(ticket.slackThreadTs || ticket.slackMessageTs || '');
  const payload = {
    channel,
    text,
    reply_broadcast: false,
    unfurl_links: false,
    unfurl_media: false,
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return slackApi_('chat.postMessage', payload);
}

function postPrivacyNoticeToThread_(ticket) {
  const channel = String(ticket.slackChannel || '');
  const threadTs = String(ticket.slackThreadTs || ticket.slackMessageTs || '');

  if (!channel || !threadTs) {
    throw new Error('Не найден Slack thread для уведомления о персональных данных по тикету ' + ticket.id + '.');
  }

  return slackApi_('chat.postMessage', {
    channel,
    thread_ts: threadTs,
    text:
      '<@' + ticket.authorId + '>, часть данных была автоматически удалена из публичной карточки тикета. ' +
      'Согласно требованиям отдела информационной безопасности, персональные данные и внутренние идентификаторы, включая ПИНФЛ, серии и номера паспортов, номера телефонов и метрики, нельзя публиковать в общих каналах. ' +
      'Если эти сведения нужны для выполнения заявки, передайте их администратору только через личные чаты Slack.',
    reply_broadcast: false,
    unfurl_links: false,
    unfurl_media: false,
  });
}

function postTicketTypeResponsibleNoticeToThread_(ticket, notice) {
  const channel = String(ticket.slackChannel || '');
  const threadTs = String(ticket.slackThreadTs || ticket.slackMessageTs || '');

  if (!channel || !threadTs) {
    throw new Error('Не найден Slack thread для уведомления ответственного по тикету ' + ticket.id + '.');
  }

  return slackApi_('chat.postMessage', {
    channel,
    thread_ts: threadTs,
    text: notice.userIds.map(function (userId) {
      return '<@' + userId + '>';
    }).join(' ') + ' ' + notice.message,
    reply_broadcast: false,
    unfurl_links: false,
    unfurl_media: false,
  });
}

function slackMessageRef_(payload, ticket) {
  const container = payload.container || {};
  const message = payload.message || {};
  const channel = (payload.channel && payload.channel.id) || container.channel_id || ticket.slackChannel;
  const ts = container.message_ts || message.thread_ts || message.ts || ticket.slackMessageTs || ticket.slackThreadTs;

  if (!channel || !ts) {
    throw new Error('Не удалось определить Slack channel/ts для обновления тикета.');
  }

  return {
    channel: String(channel),
    ts: String(ts),
  };
}

function postAttachedFilesToThread_(ticket, files) {
  const normalizedFiles = normalizeFiles_(files);

  if (!normalizedFiles.length) {
    return;
  }

  const channel = String(ticket.slackChannel);
  const threadTs = String(ticket.slackThreadTs || ticket.slackMessageTs);
  const imageFiles = normalizedFiles.filter(isImageFile_);

  if (!threadTs) {
    throw new Error('Не найден thread_ts для отправки фото тикета ' + ticket.id + '.');
  }

  if (!imageFiles.length) {
    postFileLinksToThread_(channel, threadTs, ticket, normalizedFiles);
    return;
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Прикрепленные фото к ' + escapeSlack_(ticket.id) + ':*',
      },
    },
  ];

  imageFiles.forEach(function (file, index) {
    blocks.push({
      type: 'image',
      title: {
        type: 'plain_text',
        text: truncatePlainText_(file.title || file.name || 'Фото ' + (index + 1), 120),
      },
      slack_file: {
        id: file.id,
      },
      alt_text: truncatePlainText_('Фото к тикету ' + ticket.id + ' ' + (file.title || file.name || file.id), 2000),
    });
  });

  try {
    slackApi_('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: 'Прикрепленные фото к ' + ticket.id,
      blocks,
      reply_broadcast: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    postFileLinksToThread_(channel, threadTs, ticket, normalizedFiles);
    safeAppendEvent_(ticket.id, 'File Preview Fallback', ticket.authorId, ticket.status, friendlyError_(error));
  }
}

function postFileLinksToThread_(channel, threadTs, ticket, files) {
  const lines = files.map(function (file) {
    const info = safeSlackFileInfo_(file.id);
    const title = escapeSlack_((info && (info.title || info.name)) || file.title || file.name || file.id);
    const permalink = info && info.permalink;

    return permalink ? '• <' + permalink + '|' + title + '>' : '• ' + title + ' (`' + file.id + '`)';
  });

  slackApi_('chat.postMessage', {
    channel,
    thread_ts: threadTs,
    text: '*Прикрепленные фото к ' + ticket.id + ':*\n' + lines.join('\n'),
    reply_broadcast: false,
    unfurl_links: true,
    unfurl_media: true,
  });
}

function safeSlackFileInfo_(fileId) {
  try {
    return slackApi_('files.info', { file: fileId }).file;
  } catch (error) {
    console.error(friendlyError_(error));
    return null;
  }
}

function normalizeFiles_(files) {
  if (!files) {
    return [];
  }

  if (Array.isArray(files)) {
    return files.filter(function (file) {
      return file && file.id;
    });
  }

  try {
    return JSON.parse(files).filter(function (file) {
      return file && file.id;
    });
  } catch (error) {
    return [];
  }
}

function isImageFile_(file) {
  const extension = String(file.filetype || file.name || file.title || '').toLowerCase();
  const mimetype = String(file.mimetype || '').toLowerCase();

  return mimetype.indexOf('image/') === 0 || /\.(jpe?g|png|gif)$/i.test(extension) || ['jpg', 'jpeg', 'png', 'gif'].indexOf(extension) !== -1;
}

function buildTicketAttachment_(ticket) {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ticket.id,
      },
    },
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: statusHeaderText_(ticket.status),
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '*Создано:* ' + slackDate_(ticket.createdAt),
        },
        {
          type: 'mrkdwn',
          text: '*Приоритет:* ' + escapeSlack_(ticket.priority),
        },
      ],
    },
    {
      type: 'section',
      fields: ticketFields_(ticket),
    },
  ];

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Детали:*\n' + truncateSlackText_(escapeSlack_(ticket.details), 500),
      },
    }
  );

  const actionBlock = ticketActions_(ticket);

  if (actionBlock) {
    blocks.push(actionBlock);
  }

  return {
    color: statusColor_(ticket.status),
    blocks,
  };
}

function ticketFields_(ticket) {
  const support = isSupportContext_(ticket.context);
  const fields = [
    {
      type: 'mrkdwn',
      text: '*Инициатор:*\n<@' + ticket.authorId + '>',
    },
    {
      type: 'mrkdwn',
      text: '*' + (support ? 'Мед учреждение' : 'Регион / ОП') + ':*\n' + escapeSlack_(ticket.region),
    },
  ];

  if (!support) {
    fields.splice(1, 0, {
      type: 'mrkdwn',
      text: '*Тип заявки:*\n' + escapeSlack_(ticket.type),
    });
  }

  if (ticket.assigneeId) {
    fields.push({
      type: 'mrkdwn',
      text: '*Исполнитель:*\n<@' + ticket.assigneeId + '>',
    });
  }

  if (ticket.files && ticket.files.length) {
    fields.push({
      type: 'mrkdwn',
      text: '*Фото:*\n' + ticket.files.length + ' прикреплено',
    });
  }

  const resolutionTimeHours = ticketResolutionTimeHours_(ticket);

  if (resolutionTimeHours !== '' && resolutionTimeHours !== null) {
    fields.push({
      type: 'mrkdwn',
      text: '*Время решения:*\n' + formatDuration_(Number(resolutionTimeHours)),
    });
  }

  if (ticket.status === 'Rejected' && ticket.rejectionReason) {
    fields.push({
      type: 'mrkdwn',
      text: '*Причина отказа:*\n' + truncateSlackText_(escapeSlack_(ticket.rejectionReason), 300),
    });
  }

  return fields;
}

function ticketActions_(ticket) {
  if (ticket.status === 'New') {
    return {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: CALLBACKS.take,
          text: {
            type: 'plain_text',
            text: 'Взять в работу',
          },
          style: 'primary',
          value: ticketActionValue_(ticket),
        },
      ],
    };
  }

  if (ticket.status === 'In Progress') {
    const actionValue = ticketActionValue_(ticket);

    return {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: CALLBACKS.done,
          text: {
            type: 'plain_text',
            text: 'Выполнено',
          },
          style: 'primary',
          value: actionValue,
        },
        {
          type: 'button',
          action_id: CALLBACKS.reject,
          text: {
            type: 'plain_text',
            text: 'Отклонить',
          },
          style: 'danger',
          value: actionValue,
        },
      ],
    };
  }

  return null;
}

function ticketFallbackText_(ticket) {
  return ticket.id + ': ' + ticket.type + ' · ' + statusLabel_(ticket.status) + ' · ' + ticket.region;
}

function statusLabel_(status) {
  const normalizedStatus = normalizeTicketStatus_(status);
  const labels = {
    New: 'Новая',
    'In Progress': 'В работе',
    Done: 'Завершено',
    Rejected: 'Отклонено',
  };

  return labels[normalizedStatus] || status || 'Неизвестно';
}

function statusHeaderText_(status) {
  return statusIcon_(status) + ' ' + statusLabel_(status).toUpperCase();
}

function statusIcon_(status) {
  const normalizedStatus = normalizeTicketStatus_(status);
  const icons = {
    New: '🟡',
    'In Progress': '🔵',
    Done: '🟢',
    Rejected: '🔴',
  };

  return icons[normalizedStatus] || '⚪';
}

function statusColor_(status) {
  const normalizedStatus = normalizeTicketStatus_(status);
  const colors = {
    New: '#f2c744',
    'In Progress': '#2f80ed',
    Done: '#2eb67d',
    Rejected: '#e01e5a',
  };

  return colors[normalizedStatus] || '#9aa0a6';
}

function normalizeTicketStatus_(status) {
  const value = normalizeText_(status);
  const normalized = value.toLowerCase();
  const statuses = {
    new: 'New',
    'новая': 'New',
    'новый': 'New',
    'in progress': 'In Progress',
    'в работе': 'In Progress',
    done: 'Done',
    completed: 'Done',
    complete: 'Done',
    'выполнено': 'Done',
    'завершено': 'Done',
    'закрыто': 'Done',
    rejected: 'Rejected',
    'отклонено': 'Rejected',
    'отклонен': 'Rejected',
    'отклонён': 'Rejected',
    'отказ': 'Rejected',
  };

  return statuses[normalized] || value;
}

function appendTicket_(ticket) {
  const sheet = ensureTicketsSheet_(false, ticket.context);
  const headers = getHeaders_(sheet);
  const row = headers.map(function (header) {
    return ticketValueForHeader_(ticket, header);
  });

  sheet.appendRow(row);

  return {
    sheet,
    row: sheet.getLastRow(),
    ticket,
  };
}

function ticketValueForHeader_(ticket, header) {
  const values = {
    'Ticket ID': ticket.id,
    'Date Created': ticket.createdAt,
    Author: ticket.authorId,
    'Author Name': ticket.authorName,
    'Ticket Type': ticket.type,
    'Region/Branch': ticket.region,
    Priority: ticket.priority,
    Details: ticket.details,
    Status: ticket.status,
    Assignee: ticket.assigneeId,
    'Assignee Name': ticket.assigneeName,
    'Date Accepted': ticket.dateAccepted,
    'Reaction Time': ticket.reactionTimeHours,
    'Date Completed': ticket.dateCompleted,
    'Resolution Time': ticket.resolutionTimeHours,
    'Slack Channel': ticket.slackChannel,
    'Slack Message TS': ticket.slackMessageTs,
    'Slack Thread TS': ticket.slackThreadTs,
    Files: JSON.stringify(normalizeFiles_(ticket.files)),
    'Files Posted': ticket.filesPosted,
    'Redacted Fields': (ticket.redactedFields || []).join(', '),
    'Privacy Notice Sent': ticket.privacyNoticeSent,
    'Rejection Reason': ticket.rejectionReason,
    'Unaccepted Reminder Sent': ticket.unacceptedReminderSent,
    'In Progress Reminder Sent': ticket.inProgressReminderSent,
    'Responsible Notice Sent': ticket.responsibleNoticeSent,
  };

  return Object.prototype.hasOwnProperty.call(values, header) ? values[header] : '';
}

function getTicketRecord_(ticketId, context) {
  const ticketContext = normalizeTicketContext_(context || ticketContextFromId_(ticketId));
  const sheet = ensureTicketsSheet_(false, ticketContext);
  const values = sheet.getDataRange().getValues();
  const headerMap = getHeaderMap_(sheet);
  const idColumnIndex = headerMap['Ticket ID'] - 1;

  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    if (String(values[rowIndex][idColumnIndex]) === String(ticketId)) {
      return {
        sheet,
        row: rowIndex + 1,
        ticket: ticketFromRow_(values[rowIndex], headerMap, ticketContext),
      };
    }
  }

  throw new Error('Тикет ' + ticketId + ' не найден в базе.');
}

function ticketFromRow_(row, headerMap, context) {
  const id = getCell_(row, headerMap, 'Ticket ID');

  return {
    id,
    context: normalizeTicketContext_(context || ticketContextFromId_(id)),
    createdAt: asDate_(getCell_(row, headerMap, 'Date Created')),
    authorId: getCell_(row, headerMap, 'Author'),
    authorName: getCell_(row, headerMap, 'Author Name'),
    type: getCell_(row, headerMap, 'Ticket Type'),
    region: getCell_(row, headerMap, 'Region/Branch'),
    priority: getCell_(row, headerMap, 'Priority'),
    details: getCell_(row, headerMap, 'Details'),
    status: normalizeTicketStatus_(getCell_(row, headerMap, 'Status')),
    assigneeId: getCell_(row, headerMap, 'Assignee'),
    assigneeName: getCell_(row, headerMap, 'Assignee Name'),
    dateAccepted: asDateOrEmpty_(getCell_(row, headerMap, 'Date Accepted')),
    reactionTimeHours: getCell_(row, headerMap, 'Reaction Time'),
    dateCompleted: asDateOrEmpty_(getCell_(row, headerMap, 'Date Completed')),
    resolutionTimeHours: getCell_(row, headerMap, 'Resolution Time'),
    slackChannel: getCell_(row, headerMap, 'Slack Channel'),
    slackMessageTs: String(getCell_(row, headerMap, 'Slack Message TS') || ''),
    slackThreadTs: String(getCell_(row, headerMap, 'Slack Thread TS') || ''),
    files: normalizeFiles_(getCell_(row, headerMap, 'Files')),
    filesPosted: getCell_(row, headerMap, 'Files Posted'),
    redactedFields: parseCsvCell_(getCell_(row, headerMap, 'Redacted Fields')),
    privacyNoticeRequired: parseCsvCell_(getCell_(row, headerMap, 'Redacted Fields')).length > 0,
    privacyNoticeSent: getCell_(row, headerMap, 'Privacy Notice Sent'),
    rejectionReason: getCell_(row, headerMap, 'Rejection Reason'),
    unacceptedReminderSent: asDateOrEmpty_(getCell_(row, headerMap, 'Unaccepted Reminder Sent')),
    inProgressReminderSent: asDateOrEmpty_(getCell_(row, headerMap, 'In Progress Reminder Sent')),
    responsibleNoticeSent: asDateOrEmpty_(getCell_(row, headerMap, 'Responsible Notice Sent')),
  };
}

function getCell_(row, headerMap, header) {
  const column = headerMap[header];
  return column ? row[column - 1] : '';
}

function parseCsvCell_(value) {
  return String(value || '')
    .split(',')
    .map(function (item) {
      return item.trim();
    })
    .filter(Boolean);
}

function updateTicketById_(ticketId, fields, context) {
  const record = getTicketRecord_(ticketId, context);
  updateTicketFields_(record.sheet, record.row, fields);
  return getTicketRecord_(ticketId, context).ticket;
}

function updateTicketFields_(sheet, row, fields) {
  const headerMap = getHeaderMap_(sheet);

  Object.keys(fields).forEach(function (header) {
    if (!headerMap[header]) {
      throw new Error('В листе Tickets нет колонки "' + header + '".');
    }

    const range = sheet.getRange(row, headerMap[header]);
    const value = fields[header];

    if (['Slack Message TS', 'Slack Thread TS', 'Files', 'Redacted Fields', 'Rejection Reason'].indexOf(header) !== -1) {
      range.setNumberFormat('@').setValue(header === 'Files' ? JSON.stringify(normalizeFiles_(value)) : String(value || ''));
      return;
    }

    range.setValue(value);
  });
}

function appendEvent_(ticketId, event, actor, status, notes, context) {
  const sheet = ensureEventsSheet_(false, context || ticketContextFromId_(ticketId));
  sheet.appendRow([new Date(), ticketId, event, actor, status, notes || '']);
}

function appendPersonalDataAudit_(ticket, action) {
  const sheet = ensurePersonalDataAuditSheet_(false, ticket.context);

  sheet.appendRow([
    new Date(),
    ticket.id,
    ticket.authorId,
    ticket.authorName,
    (ticket.redactedFields || []).join(', '),
    action,
    ticket.slackChannel,
    ticket.slackMessageTs,
    'Personal data was redacted before public posting; raw values are not stored.',
  ]);
}

function outsideTaskFromSubmission_(payload, form) {
  const details = redactPersonalData_(form.details);

  return {
    timestamp: new Date(),
    employeeId: payload.user.id,
    employeeName: payload.user.username || payload.user.name || payload.user.id,
    count: Math.max(1, Number(form.count) || 1),
    details: details.text,
    redactedFields: details.redacted ? ['Вне Slack задачи'] : [],
    slackChannel: payload.channel && payload.channel.id || '',
  };
}

function appendOutsideTask_(task) {
  const sheet = ensureOutsideTasksSheet_();

  sheet.appendRow([
    task.timestamp,
    task.employeeId,
    task.employeeName,
    task.count,
    task.details,
    task.slackChannel,
  ]);

  if (task.redactedFields && task.redactedFields.length) {
    appendOutsideTaskPersonalDataAudit_(task);
  }
}

function appendOutsideTaskPersonalDataAudit_(task) {
  const sheet = ensurePersonalDataAuditSheet_();

  sheet.appendRow([
    new Date(),
    'Outside Slack',
    task.employeeId,
    task.employeeName,
    task.redactedFields.join(', '),
    'Outside task submitted with personal data',
    task.slackChannel,
    '',
    'Personal data was redacted before saving outside Slack task details; raw values are not stored.',
  ]);
}

function refreshDashboard_() {
  const spreadsheet = getSpreadsheet_();
  ensureTicketsSheet_();
  const sheet = getOrCreateSheet_(spreadsheet, SHEETS.dashboard);
  const reportCutoff = reportCutoffDate_() || new Date(0);

  sheet.getCharts().forEach(function (chart) {
    sheet.removeChart(chart);
  });

  sheet.clear();
  sheet.setFrozenRows(1);
  sheet.getRange('A1').setValue('Tickets Admin Dashboard');
  sheet.getRange('A1').setFontWeight('bold').setFontSize(16);
  sheet.getRange('L1').setValue('Статистика с').setFontWeight('bold');
  sheet.getRange('L2').setValue(reportCutoff).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  sheet.getRange('A3:B9').setValues([
    ['Метрика', 'Значение'],
    ['Всего тикетов', '=COUNTIFS(Tickets!B2:B,">="&$L$2)'],
    ['Новые', '=COUNTIFS(Tickets!I2:I,"New",Tickets!B2:B,">="&$L$2)'],
    ['В работе', '=COUNTIFS(Tickets!I2:I,"In Progress",Tickets!B2:B,">="&$L$2)'],
    ['Выполнено', '=COUNTIFS(Tickets!I2:I,"Done",Tickets!B2:B,">="&$L$2)'],
    ['Отклонено', '=COUNTIFS(Tickets!I2:I,"Rejected",Tickets!B2:B,">="&$L$2)'],
    ['Среднее время решения, ч', '=IFERROR(AVERAGE(FILTER((Tickets!N2:N-Tickets!L2:L)*24,Tickets!I2:I="Done",Tickets!L2:L<>"",Tickets!N2:N<>"",Tickets!B2:B>=$L$2)),0)'],
  ]);

  sheet.getRange('A11').setValue('По типам заявок');
  sheet.getRange('A12').setFormula('=IFERROR(QUERY(FILTER(Tickets!A2:W,Tickets!B2:B>=$L$2),"select Col5, count(Col1) where Col1 is not null group by Col5 label Col5 \'Тип заявки\', count(Col1) \'Количество\'",0),"")');

  sheet.getRange('D11').setValue('По регионам / ОП');
  sheet.getRange('D12').setFormula('=IFERROR(QUERY(FILTER(Tickets!A2:W,Tickets!B2:B>=$L$2),"select Col6, count(Col1) where Col1 is not null group by Col6 label Col6 \'Регион / ОП\', count(Col1) \'Количество\'",0),"")');

  sheet.getRange('G11').setValue('Закрытые по администраторам');
  sheet.getRange('G12').setFormula('=IFERROR(QUERY(FILTER(Tickets!A2:W,Tickets!B2:B>=$L$2,Tickets!I2:I="Done"),"select Col11, count(Col1) where Col1 is not null group by Col11 label Col11 \'Администратор\', count(Col1) \'Закрыто\'",0),"")');

  sheet.getRange('A24').setValue('По статусам');
  sheet.getRange('A25').setFormula('=IFERROR(QUERY(FILTER(Tickets!A2:W,Tickets!B2:B>=$L$2),"select Col9, count(Col1) where Col1 is not null group by Col9 label Col9 \'Статус\', count(Col1) \'Количество\'",0),"")');

  sheet.getRange('D24').setValue('Объем по дням');
  sheet.getRange('D25').setFormula('=IFERROR(QUERY({ARRAYFORMULA(INT(FILTER(Tickets!B2:B,Tickets!B2:B>=$L$2))),FILTER(Tickets!A2:A,Tickets!B2:B>=$L$2)},"select Col1, count(Col2) where Col2 is not null group by Col1 label Col1 \'Дата\', count(Col2) \'Тикетов\'",0),"")');

  sheet.getRange('A3:B3').setFontWeight('bold');
  sheet.getRange('A11:J11').setFontWeight('bold');
  sheet.getRange('A24:E24').setFontWeight('bold');
  sheet.getRange('B9').setNumberFormat('0.00');
  sheet.getRange('D26:D55').setNumberFormat('dd.mm.yyyy');
  sheet.autoResizeColumns(1, 12);
  sheet.hideColumns(12);

  insertDashboardCharts_(sheet);

  return sheet;
}

function refreshSupportDashboard_() {
  const spreadsheet = getSupportSpreadsheet_();
  ensureTicketsSheet_(true, TICKET_CONTEXTS.support);
  const sheet = getOrCreateSheet_(spreadsheet, SHEETS.supportDashboard);
  const ticketsSheet = formulaSheetName_(SHEETS.supportTickets);
  const reportCutoff = reportCutoffDate_() || new Date(0);

  sheet.getCharts().forEach(function (chart) {
    sheet.removeChart(chart);
  });

  sheet.clear();
  sheet.setFrozenRows(1);
  sheet.setTabColor('#0b8043');
  sheet.getRange('A1').setValue('Tech Support Dashboard');
  sheet.getRange('A1').setFontWeight('bold').setFontSize(16);
  sheet.getRange('L1').setValue('Статистика с').setFontWeight('bold');
  sheet.getRange('L2').setValue(reportCutoff).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  sheet.getRange('A3:B9').setValues([
    ['Метрика', 'Значение'],
    ['Всего тикетов', '=COUNTIFS(' + ticketsSheet + '!B2:B,">="&$L$2)'],
    ['Новые', '=COUNTIFS(' + ticketsSheet + '!I2:I,"New",' + ticketsSheet + '!B2:B,">="&$L$2)'],
    ['В работе', '=COUNTIFS(' + ticketsSheet + '!I2:I,"In Progress",' + ticketsSheet + '!B2:B,">="&$L$2)'],
    ['Выполнено', '=COUNTIFS(' + ticketsSheet + '!I2:I,"Done",' + ticketsSheet + '!B2:B,">="&$L$2)'],
    ['Отклонено', '=COUNTIFS(' + ticketsSheet + '!I2:I,"Rejected",' + ticketsSheet + '!B2:B,">="&$L$2)'],
    ['Среднее время решения, ч', '=IFERROR(AVERAGE(FILTER((' + ticketsSheet + '!N2:N-' + ticketsSheet + '!L2:L)*24,' + ticketsSheet + '!I2:I="Done",' + ticketsSheet + '!L2:L<>"",' + ticketsSheet + '!N2:N<>"",' + ticketsSheet + '!B2:B>=$L$2)),0)'],
  ]);

  sheet.getRange('A11').setValue('Закрытые по исполнителям');
  sheet.getRange('A12').setFormula('=IFERROR(QUERY(FILTER(' + ticketsSheet + '!A2:Y,' + ticketsSheet + '!B2:B>=$L$2,' + ticketsSheet + '!I2:I="Done"),"select Col11, count(Col1) where Col1 is not null group by Col11 label Col11 \'Исполнитель\', count(Col1) \'Закрыто\'",0),"")');

  sheet.getRange('D11').setValue('По мед учреждениям');
  sheet.getRange('D12').setFormula('=IFERROR(QUERY(FILTER(' + ticketsSheet + '!A2:Y,' + ticketsSheet + '!B2:B>=$L$2),"select Col6, count(Col1) where Col1 is not null group by Col6 label Col6 \'Мед учреждение\', count(Col1) \'Количество\'",0),"")');

  sheet.getRange('G11').setValue('По статусам');
  sheet.getRange('G12').setFormula('=IFERROR(QUERY(FILTER(' + ticketsSheet + '!A2:Y,' + ticketsSheet + '!B2:B>=$L$2),"select Col9, count(Col1) where Col1 is not null group by Col9 label Col9 \'Статус\', count(Col1) \'Количество\'",0),"")');

  sheet.getRange('A24').setValue('Объем по дням');
  sheet.getRange('A25').setFormula('=IFERROR(QUERY({ARRAYFORMULA(INT(FILTER(' + ticketsSheet + '!B2:B,' + ticketsSheet + '!B2:B>=$L$2))),FILTER(' + ticketsSheet + '!A2:A,' + ticketsSheet + '!B2:B>=$L$2)},"select Col1, count(Col2) where Col2 is not null group by Col1 label Col1 \'Дата\', count(Col2) \'Тикетов\'",0),"")');

  sheet.getRange('A3:B3').setFontWeight('bold');
  sheet.getRange('A11:H11').setFontWeight('bold');
  sheet.getRange('A24:B24').setFontWeight('bold');
  sheet.getRange('B9').setNumberFormat('0.00');
  sheet.getRange('A26:A55').setNumberFormat('dd.mm.yyyy');
  sheet.autoResizeColumns(1, 12);
  sheet.hideColumns(12);

  return sheet;
}

function refreshEmployeeReportSheet_() {
  const spreadsheet = getSpreadsheet_();
  ensureTicketsSheet_();
  ensureOutsideTasksSheet_();
  ensureAdminsSheet_();
  const sheet = getOrCreateSheet_(spreadsheet, SHEETS.employeeReport);
  const outsideTasksSheet = formulaSheetName_(SHEETS.outsideTasks);
  const reportCutoff = reportCutoffDate_() || new Date(0);

  sheet.clear();
  sheet.setFrozenRows(10);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#9334e6');

  sheet.getRange('A1:H1').merge();
  sheet.getRange('A1')
    .setValue('Отчет по сотруднику')
    .setFontWeight('bold')
    .setFontSize(18)
    .setFontColor('#ffffff')
    .setBackground('#5f259f')
    .setHorizontalAlignment('center');

  sheet.getRange('A3').setValue('Сотрудник');
  sheet.getRange('A4').setValue('Дата');
  sheet.getRange('A5').setValue('Slack ID');
  sheet.getRange('A3:A5').setFontWeight('bold');
  const today = new Date();
  sheet.getRange('B4').setValue(new Date(today.getFullYear(), today.getMonth(), today.getDate())).setNumberFormat('dd.mm.yyyy');
  sheet.getRange('B5').setFormula('=IFERROR(VLOOKUP(B3,J:K,2,FALSE),"")');
  sheet.getRange('L1').setValue('Статистика с').setFontWeight('bold');
  sheet.getRange('L2').setValue(reportCutoff).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('J1:K1').setValues([['Сотрудник', 'Slack ID']]).setFontWeight('bold');
  sheet.getRange('J2').setFormula('=SORT(UNIQUE(FILTER({IF(Admins!B2:B="",Admins!A2:A,Admins!B2:B&" | "&Admins!A2:A),Admins!A2:A},Admins!A2:A<>"")))');

  sheet.getRange('B3').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(sheet.getRange('J2:J'), true)
      .setAllowInvalid(false)
      .build()
  );
  sheet.getRange('B4').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireDate()
      .setAllowInvalid(false)
      .build()
  );

  sheet.getRange('A7:D7').setValues([[
    'Slack выполнено',
    '',
    'Вне Slack задач',
    '',
  ]]);
  sheet.getRange('A8:D8').setValues([[
    '=IF($B$5="","",COUNTIFS(Tickets!J:J,$B$5,Tickets!I:I,"Done",Tickets!B:B,">="&$L$2,Tickets!N:N,">="&INT($B$4),Tickets!N:N,"<"&INT($B$4)+1))',
    '',
    '=IF($B$5="","",IFERROR(SUMIFS(' + outsideTasksSheet + '!D:D,' + outsideTasksSheet + '!B:B,$B$5,' + outsideTasksSheet + '!A:A,">="&$L$2,' + outsideTasksSheet + '!A:A,">="&INT($B$4),' + outsideTasksSheet + '!A:A,"<"&INT($B$4)+1),0))',
    '',
  ]]);
  sheet.getRange('A7:D7').setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a73e8').setHorizontalAlignment('center');
  sheet.getRange('A8:D8').setFontWeight('bold').setFontSize(13).setBackground('#f8fbff').setHorizontalAlignment('center');
  sheet.getRange('A7:D8').setBorder(true, true, true, true, true, true, '#d0d7de', SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange('A11:D11').setValues([['Slack тикет', 'Дата закрытия', 'Тип', 'Детали']]);
  sheet.getRange('F11:H11').setValues([['Дата', 'Количество', 'Вне Slack задачи']]);
  sheet.getRange('A11:D11').setFontWeight('bold').setBackground('#dbe8ff');
  sheet.getRange('F11:H11').setFontWeight('bold').setBackground('#dbe8ff');
  sheet.getRange('A12').setFormula('=IF($B$5="","Выберите сотрудника",IFERROR(FILTER({Tickets!A2:A,Tickets!N2:N,Tickets!E2:E,Tickets!H2:H},Tickets!J2:J=$B$5,Tickets!I2:I="Done",Tickets!B2:B>=$L$2,Tickets!N2:N>=INT($B$4),Tickets!N2:N<INT($B$4)+1),{"Нет данных","","",""}))');
  sheet.getRange('F12').setFormula('=IF($B$5="","Выберите сотрудника",IFERROR(FILTER({' + outsideTasksSheet + '!A2:A,' + outsideTasksSheet + '!D2:D,' + outsideTasksSheet + '!E2:E},' + outsideTasksSheet + '!B2:B=$B$5,' + outsideTasksSheet + '!A2:A>=$L$2,' + outsideTasksSheet + '!A2:A>=INT($B$4),' + outsideTasksSheet + '!A2:A<INT($B$4)+1),{"Нет данных","",""}))');
  sheet.getRange('B4').setNumberFormat('dd.mm.yyyy');
  sheet.getRange('F:F').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.autoResizeColumns(1, 12);
  sheet.hideColumns(10, 2);
  sheet.hideColumns(12);

  return sheet;
}

function insertDashboardCharts_(sheet) {
  const statusChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(sheet.getRange('A25:B35'))
    .setPosition(24, 7, 0, 0)
    .setOption('title', 'Статусы тикетов')
    .build();

  const typeChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange('A12:B22'))
    .setPosition(3, 4, 0, 0)
    .setOption('title', 'Типы заявок')
    .setOption('legend', { position: 'none' })
    .build();

  const dailyChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sheet.getRange('D25:E55'))
    .setPosition(39, 1, 0, 0)
    .setOption('title', 'Созданные тикеты по дням')
    .setOption('legend', { position: 'none' })
    .build();

  sheet.insertChart(typeChart);
  sheet.insertChart(statusChart);
  sheet.insertChart(dailyChart);
}

function ensureTicketsSheet_(format, context) {
  const sheet = getOrCreateSheet_(spreadsheetForContext_(context), ticketSheetName_(context));
  ensureHeaders_(sheet, TICKET_HEADERS);
  if (format) {
    formatTicketSheet_(sheet, context);
  }
  return sheet;
}

function ensureEventsSheet_(format, context) {
  const sheet = getOrCreateSheet_(spreadsheetForContext_(context), eventSheetName_(context));
  ensureHeaders_(sheet, EVENT_HEADERS);
  if (format) {
    formatEventSheet_(sheet, context);
  }
  return sheet;
}

function ensureOutsideTasksSheet_(format) {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(SHEETS.outsideTasks);
  const legacySheet = spreadsheet.getSheetByName(LEGACY_OUTSIDE_TASKS_SHEET_NAME);

  if (!sheet && legacySheet) {
    legacySheet.setName(SHEETS.outsideTasks);
    sheet = legacySheet;
  }

  sheet = sheet || getOrCreateSheet_(spreadsheet, SHEETS.outsideTasks);
  ensureHeaders_(sheet, OUTSIDE_TASK_HEADERS);

  if (legacySheet && legacySheet.getSheetId() !== sheet.getSheetId()) {
    migrateLegacyOutsideTasks_(legacySheet, sheet);
  }

  if (format) {
    formatOutsideTasksSheet_(sheet);
  }
  return sheet;
}

function ensurePersonalDataAuditSheet_(format, context) {
  const sheet = getOrCreateSheet_(spreadsheetForContext_(context), SHEETS.personalDataAudit);
  ensureHeaders_(sheet, PERSONAL_DATA_AUDIT_HEADERS);
  if (format) {
    formatPersonalDataAuditSheet_(sheet);
  }
  return sheet;
}

function ensureAdminsSheet_(format) {
  const sheet = getOrCreateSheet_(getSpreadsheet_(), SHEETS.admins);
  ensureHeaders_(sheet, ADMIN_HEADERS);
  seedAdminsFromProperties_(sheet, CONFIG.ADMIN_USER_IDS);
  if (format) {
    formatAdminsSheet_(sheet);
  }
  return sheet;
}

function ensureSupportAdminsSheet_(format) {
  const sheet = getOrCreateSheet_(getSupportSpreadsheet_(), SHEETS.supportAdmins);
  ensureHeaders_(sheet, ADMIN_HEADERS);
  seedAdminsFromProperties_(sheet, CONFIG.SUPPORT_ADMIN_USER_IDS);
  if (format) {
    formatAdminsSheet_(sheet);
    sheet.setTabColor('#0b8043');
  }
  return sheet;
}

function ensureTicketTypesSheet_(format) {
  const sheet = getOrCreateSheet_(getSpreadsheet_(), SHEETS.ticketTypes);
  ensureHeaders_(sheet, TICKET_TYPE_HEADERS);
  seedDefaultTicketTypes_(sheet);
  if (format) {
    formatTicketTypesSheet_(sheet);
  }
  return sheet;
}

function migrateLegacyOutsideTasks_(legacySheet, targetSheet) {
  ensureHeaders_(legacySheet, OUTSIDE_TASK_HEADERS);

  if (legacySheet.getLastRow() < 2) {
    return;
  }

  const legacyHeaderMap = getHeaderMap_(legacySheet);
  const targetHeaderMap = getHeaderMap_(targetSheet);
  const existing = {};

  if (targetSheet.getLastRow() >= 2) {
    targetSheet
      .getRange(2, 1, targetSheet.getLastRow() - 1, targetSheet.getLastColumn())
      .getValues()
      .forEach(function (row) {
        existing[outsideTaskRowKey_(row, targetHeaderMap)] = true;
      });
  }

  const rowsToAppend = legacySheet
    .getRange(2, 1, legacySheet.getLastRow() - 1, legacySheet.getLastColumn())
    .getValues()
    .map(function (row) {
      return OUTSIDE_TASK_HEADERS.map(function (header) {
        return getCell_(row, legacyHeaderMap, header);
      });
    })
    .filter(function (row) {
      const key = outsideTaskRowKey_(row, headerMapFromHeaders_(OUTSIDE_TASK_HEADERS));

      if (!row[0] || existing[key]) {
        return false;
      }

      existing[key] = true;
      return true;
    });

  if (rowsToAppend.length) {
    targetSheet
      .getRange(targetSheet.getLastRow() + 1, 1, rowsToAppend.length, OUTSIDE_TASK_HEADERS.length)
      .setValues(rowsToAppend);
  }
}

function outsideTaskRowKey_(row, headerMap) {
  return OUTSIDE_TASK_HEADERS.map(function (header) {
    const value = getCell_(row, headerMap, header);
    return value instanceof Date ? value.toISOString() : String(value || '').trim();
  }).join('||');
}

function headerMapFromHeaders_(headers) {
  const map = {};

  headers.forEach(function (header, index) {
    map[header] = index + 1;
  });

  return map;
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const current = sheet
    .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
    .getValues()[0]
    .map(function (value) {
      return String(value || '').trim();
    });

  if (current.filter(Boolean).length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  let nextColumn = current.length + 1;

  headers.forEach(function (header) {
    if (current.indexOf(header) === -1) {
      sheet.getRange(1, nextColumn).setValue(header);
      current.push(header);
      nextColumn += 1;
    }
  });
}

function formatTicketSheet_(sheet, context) {
  const lastColumn = Math.max(sheet.getLastColumn(), TICKET_HEADERS.length);

  sheet.setFrozenRows(1);
  sheet.setTabColor(isSupportContext_(context) ? '#0b8043' : '#1a73e8');
  sheet.getRange(1, 1, 1, lastColumn).setFontWeight('bold');
  sheet.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('L:L').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('N:N').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('M:M').setNumberFormat('0.00');
  sheet.getRange('O:O').setNumberFormat('0.00');
  sheet.getRange('Q:R').setNumberFormat('@');
  sheet.getRange('S:S').setNumberFormat('@');
  sheet.getRange('T:T').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('U:U').setNumberFormat('@');
  sheet.getRange('V:V').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('W:W').setNumberFormat('@');
  sheet.getRange('X:Y').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('Z:Z').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.autoResizeColumns(1, Math.min(lastColumn, TICKET_HEADERS.length));
}

function formatEventSheet_(sheet, context) {
  const lastColumn = Math.max(sheet.getLastColumn(), EVENT_HEADERS.length);

  sheet.setFrozenRows(1);
  sheet.setTabColor(isSupportContext_(context) ? '#0b8043' : '#5f6368');
  sheet.getRange(1, 1, 1, lastColumn).setFontWeight('bold');
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.autoResizeColumns(1, Math.min(lastColumn, 6));
}

function formatOutsideTasksSheet_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), OUTSIDE_TASK_HEADERS.length);

  sheet.setFrozenRows(1);
  sheet.setTabColor('#fbbc04');
  sheet.getRange(1, 1, 1, lastColumn)
    .setFontWeight('bold')
    .setFontColor('#202124')
    .setBackground('#fce8b2');
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('B:C').setNumberFormat('@');
  sheet.getRange('D:D').setNumberFormat('0');
  sheet.getRange('E:F').setNumberFormat('@');
  sheet.autoResizeColumns(1, Math.min(lastColumn, OUTSIDE_TASK_HEADERS.length));
}

function formatPersonalDataAuditSheet_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), PERSONAL_DATA_AUDIT_HEADERS.length);

  sheet.setFrozenRows(1);
  sheet.setTabColor('#d93025');
  sheet.getRange(1, 1, 1, lastColumn)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#a50e0e');
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('B:H').setNumberFormat('@');
  sheet.autoResizeColumns(1, Math.min(lastColumn, PERSONAL_DATA_AUDIT_HEADERS.length));
}

function formatAdminsSheet_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), ADMIN_HEADERS.length);

  sheet.setFrozenRows(1);
  sheet.setTabColor('#34a853');
  sheet.getRange(1, 1, 1, lastColumn)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#137333');
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('D:D').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['TRUE', 'FALSE'], true)
      .setAllowInvalid(true)
      .build()
  );
  sheet.autoResizeColumns(1, Math.min(lastColumn, ADMIN_HEADERS.length));
}

function formatTicketTypesSheet_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), TICKET_TYPE_HEADERS.length);
  const headerMap = getHeaderMap_(sheet);
  const dataRowCount = Math.max(sheet.getMaxRows() - 1, 1);

  sheet.setFrozenRows(1);
  sheet.setTabColor('#f4511e');
  sheet.getRange(1, 1, 1, lastColumn)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#c5221f');

  if (headerMap['Тип заявки']) {
    sheet.getRange(2, headerMap['Тип заявки'], dataRowCount, 1).setNumberFormat('@');
  }

  if (headerMap['Активен']) {
    sheet.getRange(2, headerMap['Активен'], dataRowCount, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['TRUE', 'FALSE'], true)
        .setAllowInvalid(true)
        .build()
    );
  }

  if (headerMap['Порядок']) {
    sheet.getRange(2, headerMap['Порядок'], dataRowCount, 1)
      .clearDataValidations()
      .setNumberFormat('0');
  }

  ['Примечание', 'Ответственный Slack ID', 'Сообщение в тред'].forEach(function (header) {
    if (headerMap[header]) {
      sheet.getRange(2, headerMap[header], dataRowCount, 1).setNumberFormat('@');
    }
  });

  sheet.autoResizeColumns(1, Math.min(lastColumn, TICKET_TYPE_HEADERS.length));

  if (headerMap['Ответственный Slack ID']) {
    sheet.setColumnWidth(headerMap['Ответственный Slack ID'], 180);
  }

  if (headerMap['Сообщение в тред']) {
    sheet.setColumnWidth(headerMap['Сообщение в тред'], 360);
    sheet.getRange(2, headerMap['Сообщение в тред'], dataRowCount, 1).setWrap(true);
  }
}

function seedAdminsFromProperties_(sheet, propertyName) {
  if (sheet.getLastRow() > 1) {
    return;
  }

  const ids = getAdminIdsFromPropertiesByName_(propertyName || CONFIG.ADMIN_USER_IDS);

  if (!ids.length) {
    return;
  }

  const rows = ids.map(function (id) {
    return [id, '', 'Admin', 'TRUE', 'Imported from ADMIN_USER_IDS'];
  });

  sheet.getRange(2, 1, rows.length, ADMIN_HEADERS.length).setValues(rows);
}

function seedDefaultTicketTypes_(sheet) {
  if (sheet.getLastRow() > 1) {
    return;
  }

  const rows = DEFAULT_TICKET_TYPES.map(function (type, index) {
    return [type, 'TRUE', index + 1, 'Можно изменить или отключить', '', ''];
  });

  sheet.getRange(2, 1, rows.length, TICKET_TYPE_HEADERS.length).setValues(rows);
}

function getSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const storedId = properties.getProperty(CONFIG.SPREADSHEET_ID);

  if (storedId) {
    return SpreadsheetApp.openById(storedId);
  }

  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (activeSpreadsheet) {
    properties.setProperty(CONFIG.SPREADSHEET_ID, activeSpreadsheet.getId());
    return activeSpreadsheet;
  }

  const spreadsheet = SpreadsheetApp.create('Tickets Admin DB');
  properties.setProperty(CONFIG.SPREADSHEET_ID, spreadsheet.getId());

  return spreadsheet;
}

function getSupportSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const storedId = properties.getProperty(CONFIG.SUPPORT_SPREADSHEET_ID);

  if (storedId) {
    return SpreadsheetApp.openById(storedId);
  }

  const spreadsheet = SpreadsheetApp.create('Tech Support Tickets DB');
  properties.setProperty(CONFIG.SUPPORT_SPREADSHEET_ID, spreadsheet.getId());

  return spreadsheet;
}

function migrateSupportDataToDedicatedSpreadsheet_(sourceSpreadsheet, targetSpreadsheet) {
  if (sourceSpreadsheet.getId() === targetSpreadsheet.getId()) {
    throw new Error('SUPPORT_SPREADSHEET_ID должен указывать на отдельную Google-таблицу.');
  }

  migrateSupportSheet_(
    sourceSpreadsheet,
    targetSpreadsheet,
    SHEETS.supportTickets,
    TICKET_HEADERS,
    ['Ticket ID']
  );
  migrateSupportSheet_(
    sourceSpreadsheet,
    targetSpreadsheet,
    SHEETS.supportEvents,
    EVENT_HEADERS,
    EVENT_HEADERS
  );
  migrateSupportSheet_(
    sourceSpreadsheet,
    targetSpreadsheet,
    SHEETS.supportAdmins,
    ADMIN_HEADERS,
    ['Slack User ID']
  );
  migrateSupportAuditRows_(sourceSpreadsheet, targetSpreadsheet);
  removeMigratedGeneratedSheet_(sourceSpreadsheet, SHEETS.supportReports);
  removeMigratedGeneratedSheet_(sourceSpreadsheet, SHEETS.supportDashboard);
}

function migrateSupportSheet_(sourceSpreadsheet, targetSpreadsheet, sheetName, headers, keyHeaders) {
  const sourceSheet = sourceSpreadsheet.getSheetByName(sheetName);

  if (!sourceSheet) {
    return;
  }

  const targetSheet = targetSpreadsheet.getSheetByName(sheetName);

  if (!targetSheet) {
    sourceSheet.copyTo(targetSpreadsheet).setName(sheetName);
    removeMigratedSheet_(sourceSpreadsheet, sourceSheet);
    return;
  }

  ensureHeaders_(sourceSheet, headers);
  ensureHeaders_(targetSheet, headers);
  appendMissingMigratedRows_(targetSheet, headers, keyHeaders, rowsForMigration_(sourceSheet, headers));
  removeMigratedSheet_(sourceSpreadsheet, sourceSheet);
}

function migrateSupportAuditRows_(sourceSpreadsheet, targetSpreadsheet) {
  const sourceSheet = sourceSpreadsheet.getSheetByName(SHEETS.personalDataAudit);

  if (!sourceSheet || sourceSheet.getLastRow() < 2) {
    return;
  }

  ensureHeaders_(sourceSheet, PERSONAL_DATA_AUDIT_HEADERS);
  const headerMap = getHeaderMap_(sourceSheet);
  const ticketIdColumn = headerMap['Ticket ID'];

  if (!ticketIdColumn) {
    return;
  }

  const sourceRows = sourceSheet
    .getRange(2, 1, sourceSheet.getLastRow() - 1, sourceSheet.getLastColumn())
    .getValues();
  const rowsToMove = [];
  const rowNumbersToRemove = [];

  sourceRows.forEach(function (row, index) {
    if (ticketContextFromId_(row[ticketIdColumn - 1]) !== TICKET_CONTEXTS.support) {
      return;
    }

    rowsToMove.push(PERSONAL_DATA_AUDIT_HEADERS.map(function (header) {
      return getCell_(row, headerMap, header);
    }));
    rowNumbersToRemove.push(index + 2);
  });

  if (!rowsToMove.length) {
    return;
  }

  const targetSheet = getOrCreateSheet_(targetSpreadsheet, SHEETS.personalDataAudit);
  ensureHeaders_(targetSheet, PERSONAL_DATA_AUDIT_HEADERS);
  appendMissingMigratedRows_(
    targetSheet,
    PERSONAL_DATA_AUDIT_HEADERS,
    PERSONAL_DATA_AUDIT_HEADERS,
    rowsToMove
  );

  rowNumbersToRemove.reverse().forEach(function (rowNumber) {
    sourceSheet.deleteRow(rowNumber);
  });
}

function rowsForMigration_(sheet, headers) {
  if (sheet.getLastRow() < 2) {
    return [];
  }

  const headerMap = getHeaderMap_(sheet);

  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues()
    .map(function (row) {
      return headers.map(function (header) {
        return getCell_(row, headerMap, header);
      });
    })
    .filter(function (row) {
      return row.some(function (value) {
        return value !== '' && value !== null && value !== undefined;
      });
    });
}

function appendMissingMigratedRows_(targetSheet, headers, keyHeaders, rows) {
  if (!rows.length) {
    return;
  }

  const headerMap = headerMapFromHeaders_(headers);
  const existingKeys = {};

  rowsForMigration_(targetSheet, headers).forEach(function (row) {
    existingKeys[migrationRowKey_(row, headerMap, keyHeaders)] = true;
  });

  const rowsToAppend = rows.filter(function (row) {
    const key = migrationRowKey_(row, headerMap, keyHeaders);

    if (!key || existingKeys[key]) {
      return false;
    }

    existingKeys[key] = true;
    return true;
  });

  if (rowsToAppend.length) {
    targetSheet
      .getRange(targetSheet.getLastRow() + 1, 1, rowsToAppend.length, headers.length)
      .setValues(rowsToAppend);
  }
}

function migrationRowKey_(row, headerMap, keyHeaders) {
  return keyHeaders
    .map(function (header) {
      const value = getCell_(row, headerMap, header);
      return value instanceof Date ? value.toISOString() : String(value || '').trim();
    })
    .join('||');
}

function removeMigratedGeneratedSheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (sheet) {
    removeMigratedSheet_(spreadsheet, sheet);
  }
}

function removeMigratedSheet_(spreadsheet, sheet) {
  if (spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(sheet);
    return;
  }

  sheet.clear();
  sheet.setName('Moved to Tech Support Sheet');
}

function removeEmptyDefaultSupportSheet_(spreadsheet) {
  ['Sheet1', 'Лист1'].some(function (name) {
    const sheet = spreadsheet.getSheetByName(name);

    if (!sheet || spreadsheet.getSheets().length < 2 || sheet.getLastRow() > 0) {
      return false;
    }

    spreadsheet.deleteSheet(sheet);
    return true;
  });
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function getHeaders_(sheet) {
  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (value) {
      return String(value || '').trim();
    });
}

function getHeaderMap_(sheet) {
  const headers = getHeaders_(sheet);
  const map = {};

  headers.forEach(function (header, index) {
    if (header) {
      map[header] = index + 1;
    }
  });

  return map;
}

function formulaSheetName_(name) {
  return "'" + String(name || '').replace(/'/g, "''") + "'";
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function slackApi_(method, payload) {
  const token = getRequiredProperty_(CONFIG.SLACK_BOT_TOKEN);
  const response = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: {
      Authorization: 'Bearer ' + token,
    },
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });

  const body = response.getContentText();
  const data = JSON.parse(body || '{}');

  if (response.getResponseCode() >= 300 || !data.ok) {
    throw new Error('Slack API ' + method + ' failed: ' + body);
  }

  return data;
}

function isAdmin_(userId, context) {
  const normalizedUserId = normalizeText_(userId).toUpperCase();

  if (!normalizedUserId) {
    return false;
  }

  const sheetAdminIds = getActiveAdminIds_(context);

  if (sheetAdminIds.length) {
    return sheetAdminIds.indexOf(normalizedUserId) !== -1;
  }

  return getAdminIdsFromProperties_(context).indexOf(normalizedUserId) !== -1;
}

function getActiveAdminIds_(context) {
  const ticketContext = normalizeTicketContext_(context);
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ACTIVE_ADMIN_IDS_' + ticketContext;
  const cached = cache.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  const ids = readActiveAdminIdsFromSheet_(ticketContext);
  cache.put(cacheKey, JSON.stringify(ids), 60);

  return ids;
}

function readActiveAdminIdsFromSheet_(context) {
  const sheet = isSupportContext_(context) ? ensureSupportAdminsSheet_() : ensureAdminsSheet_();

  if (sheet.getLastRow() < 2) {
    return [];
  }

  const headerMap = getHeaderMap_(sheet);
  const idColumn = headerMap['Slack User ID'];
  const activeColumn = headerMap.Active;

  if (!idColumn) {
    return [];
  }

  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues()
    .map(function (row) {
      return {
        id: normalizeText_(row[idColumn - 1]).toUpperCase(),
        active: activeColumn ? row[activeColumn - 1] : true,
      };
    })
    .filter(function (admin) {
      return admin.id && isActiveAdminValue_(admin.active);
    })
    .map(function (admin) {
      return admin.id;
    });
}

function getAdminIdsFromProperties_(context) {
  return getAdminIdsFromPropertiesByName_(isSupportContext_(context) ? CONFIG.SUPPORT_ADMIN_USER_IDS : CONFIG.ADMIN_USER_IDS);
}

function getAdminIdsFromPropertiesByName_(propertyName) {
  return getProperty_(propertyName, '')
    .split(/[,\s]+/)
    .map(function (id) {
      return normalizeText_(id).toUpperCase();
    })
    .filter(Boolean);
}

function isActiveAdminValue_(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return ['false', 'no', 'нет', '0', 'disabled', 'inactive', 'off'].indexOf(normalized) === -1;
}

function getRequiredProperty_(name) {
  const value = getProperty_(name, '');

  if (!value) {
    throw new Error('Заполните Script Property ' + name + '.');
  }

  return value;
}

function getProperty_(name, defaultValue) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  return value === null || value === undefined ? defaultValue : value;
}

function textOutput_(text) {
  return ContentService.createTextOutput(text);
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload || {}))
    .setMimeType(ContentService.MimeType.JSON);
}

function ephemeralResponse_(text) {
  return jsonOutput_({
    response_type: 'ephemeral',
    replace_original: false,
    text,
  });
}

function actionWarningResponse_(payload, text) {
  try {
    postEphemeral_(payload, text);
  } catch (error) {
    console.error(friendlyError_(error));
  }

  return ephemeralResponse_(text);
}

function postEphemeral_(payload, text) {
  const channel = actionChannelId_(payload);
  const user = payload.user && payload.user.id;

  if (!user) {
    throw new Error('Slack не передал user_id для эфемерального сообщения.');
  }

  return slackApi_('chat.postEphemeral', {
    channel,
    user,
    text,
  });
}

function normalizeText_(value) {
  return String(value || '').trim();
}

function escapeSlack_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateSlackText_(value, limit) {
  const text = String(value || '');

  if (text.length <= limit) {
    return text;
  }

  return text.slice(0, limit - 1) + '…';
}

function truncatePlainText_(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length <= limit) {
    return text;
  }

  return text.slice(0, limit - 1) + '…';
}

function slackDate_(value) {
  const date = asDate_(value);
  const unixTime = Math.floor(date.getTime() / 1000);
  const fallback = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');

  return '<!date^' + unixTime + '^{date_short_pretty} {time}|' + fallback + '>';
}

function asDate_(value) {
  if (value instanceof Date) {
    return value;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Некорректная дата: ' + value);
  }

  return date;
}

function asDateOrEmpty_(value) {
  if (!value) {
    return '';
  }

  return asDate_(value);
}

function hoursBetween_(start, end) {
  const startDate = asDate_(start);
  const endDate = asDate_(end);
  return Math.round(((endDate.getTime() - startDate.getTime()) / 3600000) * 100) / 100;
}

function formatDuration_(hours) {
  if (Number.isNaN(hours)) {
    return '-';
  }

  if (hours < 1) {
    return Math.max(1, Math.round(hours * 60)) + ' мин';
  }

  if (hours < 24) {
    return hours.toFixed(1) + ' ч';
  }

  return (hours / 24).toFixed(1) + ' дн';
}

function logRuntimeError_(error) {
  console.error(friendlyError_(error));

  try {
    appendEvent_('', 'Error', '', '', friendlyError_(error));
  } catch (ignored) {
    console.error(friendlyError_(ignored));
  }
}

function friendlyError_(error) {
  return String((error && error.stack) || (error && error.message) || error)
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[slack-token]');
}
