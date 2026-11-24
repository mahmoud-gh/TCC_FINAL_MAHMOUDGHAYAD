function parseWhatsAppChange(value) {
  const messages = [];
  const statuses = [];

  const contactNames = {};
  for (const contact of value.contacts || []) {
    contactNames[contact.wa_id] = contact.profile && contact.profile.name;
  }

  for (const msg of value.messages || []) {
    const base = {
      platform: 'whatsapp',
      platformUserId: msg.from,
      displayName: contactNames[msg.from] || null,
      phone: msg.from,
      platformMessageId: msg.id,
      timestamp: msg.timestamp,
    };

    if (msg.type === 'text') {
      messages.push({ ...base, messageType: 'text', text: msg.text.body });
    } else if (['image', 'audio', 'video', 'document'].includes(msg.type)) {
      const media = msg[msg.type];
      messages.push({
        ...base,
        messageType: msg.type,
        text: (media && media.caption) || null,
        mediaId: media && media.id,
      });
    } else if (msg.type === 'interactive') {
      const interactive = msg.interactive || {};
      if (interactive.type === 'button_reply') {
        messages.push({
          ...base,
          messageType: 'interactive_button_reply',
          text: interactive.button_reply.title,
          interactiveId: interactive.button_reply.id,
        });
      } else if (interactive.type === 'list_reply') {
        messages.push({
          ...base,
          messageType: 'interactive_list_reply',
          text: interactive.list_reply.title,
          interactiveId: interactive.list_reply.id,
        });
      } else {
        messages.push({ ...base, messageType: 'interactive', text: null });
      }
    } else {
      messages.push({ ...base, messageType: msg.type, text: null });
    }
  }

    for (const status of value.statuses || []) {
    statuses.push({
      platformMessageId: status.id,
      status: status.status,
      // A Meta informa aqui o motivo quando a entrega falha.
      errors: status.errors || null,
    });
  }

  return { messages, statuses };
}

function parseInstagramEntry(entry) {
  const messages = [];

  for (const event of entry.messaging || []) {
    if (!event.message || event.message.is_echo) continue;

    const base = {
      platform: 'instagram',
      platformUserId: event.sender.id,
      displayName: null,
      phone: null,
      platformMessageId: event.message.mid,
      timestamp: event.timestamp,
    };

    if (event.message.text) {
      messages.push({
        ...base,
        messageType: 'text',
        text: event.message.text,
        interactiveId: event.message.quick_reply ? event.message.quick_reply.payload : undefined,
      });
    }

    for (const attachment of event.message.attachments || []) {
      messages.push({
        ...base,
        messageType: attachment.type || 'file',
        text: null,
        mediaUrl: attachment.payload && attachment.payload.url,
      });
    }
  }

  return { messages, statuses: [] };
}

function parseWebhookBody(body) {
  const messages = [];
  const statuses = [];

  for (const entry of body.entry || []) {
    if (body.object === 'whatsapp_business_account') {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') {
          const parsed = parseWhatsAppChange(change.value);
          messages.push(...parsed.messages);
          statuses.push(...parsed.statuses);
        }
      }
    } else if (body.object === 'instagram') {
      const parsed = parseInstagramEntry(entry);
      messages.push(...parsed.messages);
      statuses.push(...parsed.statuses);
    }
  }

  return { messages, statuses };
}

module.exports = { parseWebhookBody };
