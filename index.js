import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing required environment variable: DISCORD_TOKEN");
  process.exit(1);
}
if (!process.env.CLIENT_ID) {
  console.warn("CLIENT_ID is not set; slash command registration will be skipped.");
}

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

const hasDatabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!hasDatabase) {
  console.warn("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; running in fallback mode (database actions skipped).");
}
const database = hasDatabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const health = {
  ready: false,
  startedAt: new Date().toISOString(),
  readyAt: null,
  lastDisconnect: null,
  guilds: 0,
};

const commands = [
  { name: "setup", description: "Build the Rustic Utilities creator server layout", default_member_permissions: "8" },
  { name: "verify", description: "Post the configured verification panel", default_member_permissions: "32" },
  { name: "ticket", description: "Open the configured ticket menu" },
  {
    name: "giveaway",
    description: "Start a giveaway",
    default_member_permissions: "32",
    options: [
      { name: "prize", description: "Prize to give away", type: 3, required: true },
      { name: "minutes", description: "Duration in minutes", type: 4, required: true, min_value: 1 },
      { name: "winners", description: "Number of winners", type: 4, min_value: 1, max_value: 20 },
    ],
  },
  {
    name: "embed",
    description: "Send a simple embed",
    default_member_permissions: "32",
    options: [
      { name: "title", description: "Embed title", type: 3, required: true },
      { name: "message", description: "Embed message", type: 3, required: true },
      { name: "channel", description: "Destination channel", type: 7 },
    ],
  },
  {
    name: "announce",
    description: "Post an announcement",
    default_member_permissions: "32",
    options: [{ name: "message", description: "Announcement text", type: 3, required: true }],
  },
  ...["warn", "kick", "ban"].map((name) => ({
    name,
    description: `${name[0].toUpperCase()}${name.slice(1)} a member`,
    default_member_permissions: name === "ban" ? "4" : name === "kick" ? "2" : "8192",
    options: [
      { name: "member", description: "Member to moderate", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3 },
    ],
  })),
  {
    name: "timeout",
    description: "Timeout a member",
    default_member_permissions: "1099511627776",
    options: [
      { name: "member", description: "Member to timeout", type: 6, required: true },
      { name: "minutes", description: "Timeout duration", type: 4, required: true, min_value: 1, max_value: 40320 },
      { name: "reason", description: "Reason", type: 3 },
    ],
  },
  {
    name: "purge",
    description: "Delete recent messages",
    default_member_permissions: "8192",
    options: [{ name: "count", description: "Messages to delete", type: 4, required: true, min_value: 1, max_value: 100 }],
  },
  {
    name: "slowmode",
    description: "Set this channel's slowmode",
    default_member_permissions: "16",
    options: [{ name: "seconds", description: "Delay from 0 to 21600 seconds", type: 4, required: true, min_value: 0, max_value: 21600 }],
  },
  { name: "help", description: "Show Rustic Utilities commands" },
];

const creatorTemplate = [
  ["INFORMATION", ["welcome", "rules", "announcements", "server-info"]],
  ["CONTENT CREATORS", ["creator-chat", "content-ideas", "self-promotion", "video-feedback", "collaborations"]],
  ["SOCIAL MEDIA", ["youtube", "tiktok", "instagram", "twitch"]],
  ["COMMUNITY", ["general", "media", "memes", "bot-commands"]],
  ["SUPPORT", ["tickets", "help", "reports"]],
];

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1900 ? `${message.slice(0, 1897)}...` : message;
}

function requireDatabase() {
  if (!database) throw new Error("Database is not configured on this bot host; this action is unavailable.");
}

async function guildOwner(guildId) {
  if (!database) return null;
  const { data, error } = await database
    .from("guild_configs")
    .select("user_id")
    .eq("guild_id", guildId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function guildConfig(guildId) {
  if (!database) return null;
  const { data, error } = await database
    .from("guild_configs")
    .select("*")
    .eq("guild_id", guildId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function audit(guildId, event, detail, status = "success") {
  if (!database) return;
  try {
    const userId = await guildOwner(guildId);
    if (!userId) return;
    const { error } = await database.from("audit_logs").insert({
      user_id: userId,
      guild_id: guildId,
      event,
      detail,
      status,
    });
    if (error) console.error("Audit write failed:", error.message);
  } catch (error) {
    console.error("Audit write failed:", safeError(error));
  }
}

async function moderationLog(interaction, action, target, reason, duration = null) {
  if (!database) return;
  const userId = await guildOwner(interaction.guildId);
  if (!userId) return;
  const { error } = await database.from("moderation_logs").insert({
    user_id: userId,
    guild_id: interaction.guildId,
    action,
    target_id: target.id,
    target_name: target.tag ?? target.username,
    reason,
    duration,
  });
  if (error) throw error;
}

function verificationPanel(config) {
  const verification = config?.verification ?? {};
  const raw = verification.embed ?? {};
  const embed = new EmbedBuilder()
    .setTitle(raw.title || "Verify yourself")
    .setDescription(raw.description || "Press the button below to unlock the server.")
    .setColor(raw.color || 0x5865f2);
  const button = new ButtonBuilder()
    .setCustomId(`rustic:verify:${verification.role_id || "missing"}`)
    .setLabel(verification.button_label || "Verify me")
    .setStyle(ButtonStyle.Success);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

async function handleSetup(interaction) {
  await interaction.deferReply({ ephemeral: true });
  for (const [categoryName, channelNames] of creatorTemplate) {
    let category = interaction.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName,
    );
    category ??= await interaction.guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
    for (const name of channelNames) {
      const exists = interaction.guild.channels.cache.find(
        (channel) => channel.parentId === category.id && channel.name === name,
      );
      if (!exists) await interaction.guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id });
    }
  }
  await audit(interaction.guildId, "creator_server_built", `Triggered by ${interaction.user.tag}`);
  await interaction.editReply("Creator server structure created successfully.");
}

async function handleVerifyCommand(interaction) {
  const config = await guildConfig(interaction.guildId);
  const channelId = config?.verification?.channel_id;
  const channel = channelId ? await interaction.guild.channels.fetch(channelId) : interaction.channel;
  if (!channel?.isTextBased()) throw new Error("The configured verification channel is unavailable.");
  await channel.send(verificationPanel(config));
  await interaction.reply({ content: `Verification panel posted in <#${channel.id}>.`, ephemeral: true });
}

async function handleTicketCommand(interaction) {
  requireDatabase();
  const { data, error } = await database.from("tickets").select("id,type_name,emoji").eq("guild_id", interaction.guildId).eq("status", "open").limit(5);
  if (error) throw error;
  if (!data?.length) return interaction.reply({ content: "No ticket types are configured yet.", ephemeral: true });
  const buttons = data.map((ticket) => new ButtonBuilder()
    .setCustomId(`rustic:ticket:${ticket.id}`)
    .setLabel(ticket.type_name)
    .setEmoji(ticket.emoji || "🎫")
    .setStyle(ButtonStyle.Secondary));
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle("Need help?").setDescription("Choose a ticket type below.").setColor(0x5865f2)],
    components: [new ActionRowBuilder().addComponents(buttons)],
  });
}

async function handleGiveaway(interaction) {
  requireDatabase();
  const prize = interaction.options.getString("prize", true);
  const minutes = interaction.options.getInteger("minutes", true);
  const winners = interaction.options.getInteger("winners") ?? 1;
  const endsAt = new Date(Date.now() + minutes * 60_000);
  const userId = await guildOwner(interaction.guildId);
  if (!userId) throw new Error("Connect this server in the Rustic Utilities dashboard first.");
  const { data, error } = await database.from("giveaways").insert({
    user_id: userId,
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    prize,
    winners,
    ends_at: endsAt.toISOString(),
    status: "running",
  }).select("id").single();
  if (error) throw error;
  const response = await interaction.reply({
    embeds: [new EmbedBuilder().setTitle(`🎉 Giveaway: ${prize}`).setDescription(`Winners: ${winners}\nEnds: <t:${Math.floor(endsAt.getTime() / 1000)}:R>`).setColor(0x57f287)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rustic:giveaway:${data.id}`).setLabel("Enter").setEmoji("🎉").setStyle(ButtonStyle.Success))],
    fetchReply: true,
  });
  await database.from("giveaways").update({ message_id: response.id }).eq("id", data.id);
}

async function handleModeration(interaction) {
  const action = interaction.commandName;
  const user = interaction.options.getUser("member", true);
  const member = await interaction.guild.members.fetch(user.id);
  const reason = interaction.options.getString("reason") || `Action by ${interaction.user.tag}`;
  let duration = null;
  if (action === "warn") await user.send(`You were warned in **${interaction.guild.name}**: ${reason}`).catch(() => undefined);
  if (action === "kick") await member.kick(reason);
  if (action === "ban") await interaction.guild.members.ban(user.id, { reason });
  if (action === "timeout") {
    const minutes = interaction.options.getInteger("minutes", true);
    duration = `${minutes} minutes`;
    await member.timeout(minutes * 60_000, reason);
  }
  await moderationLog(interaction, action, user, reason, duration);
  await interaction.reply({ content: `${action} completed for ${user.tag}.`, ephemeral: true });
}

async function handleCommand(interaction) {
  const name = interaction.commandName;
  if (name === "setup") return handleSetup(interaction);
  if (name === "verify") return handleVerifyCommand(interaction);
  if (name === "ticket") return handleTicketCommand(interaction);
  if (name === "giveaway") return handleGiveaway(interaction);
  if (["warn", "timeout", "kick", "ban"].includes(name)) return handleModeration(interaction);
  if (name === "purge") {
    const count = interaction.options.getInteger("count", true);
    if (!interaction.channel?.isTextBased() || !("bulkDelete" in interaction.channel)) throw new Error("This channel does not support bulk deletion.");
    const deleted = await interaction.channel.bulkDelete(count, true);
    await audit(interaction.guildId, "messages_purged", `${deleted.size} messages by ${interaction.user.tag}`);
    return interaction.reply({ content: `Deleted ${deleted.size} messages.`, ephemeral: true });
  }
  if (name === "slowmode") {
    const seconds = interaction.options.getInteger("seconds", true);
    if (!interaction.channel?.isTextBased() || !("setRateLimitPerUser" in interaction.channel)) throw new Error("This channel does not support slowmode.");
    await interaction.channel.setRateLimitPerUser(seconds, `Changed by ${interaction.user.tag}`);
    await audit(interaction.guildId, "slowmode_changed", `${seconds}s by ${interaction.user.tag}`);
    return interaction.reply({ content: `Slowmode set to ${seconds} seconds.`, ephemeral: true });
  }
  if (name === "embed" || name === "announce") {
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel?.isTextBased()) throw new Error("Choose a text channel.");
    const title = name === "embed" ? interaction.options.getString("title", true) : "Announcement";
    const message = interaction.options.getString("message", true);
    await channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(message).setColor(0x5865f2)] });
    await audit(interaction.guildId, `${name}_sent`, `Sent by ${interaction.user.tag}`);
    return interaction.reply({ content: `Posted in <#${channel.id}>.`, ephemeral: true });
  }
  return interaction.reply({
    content: "**Rustic Utilities commands**\n/setup · /verify · /ticket · /giveaway · /embed · /announce · /warn · /timeout · /kick · /ban · /purge · /slowmode",
    ephemeral: true,
  });
}

async function handleButton(interaction) {
  const [prefix, kind, id] = interaction.customId.split(":");
  if (prefix !== "rustic" || !id) return;
  if (kind === "verify") {
    if (id === "missing") throw new Error("No verification role is configured.");
    const member = await interaction.guild.members.fetch(interaction.user.id);
    await member.roles.add(id, "Rustic Utilities verification");
    return interaction.reply({ content: "You are verified.", ephemeral: true });
  }
  if (kind === "role") {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasRole = member.roles.cache.has(id);
    if (hasRole) await member.roles.remove(id, "Rustic Utilities self-role");
    else await member.roles.add(id, "Rustic Utilities self-role");
    return interaction.reply({ content: hasRole ? "Role removed." : "Role added.", ephemeral: true });
  }
  if (kind === "giveaway") {
    requireDatabase();
    const { data, error } = await database.from("giveaways").select("entries,requirements,status").eq("id", id).eq("guild_id", interaction.guildId).single();
    if (error) throw error;
    if (data.status !== "running") return interaction.reply({ content: "This giveaway has ended.", ephemeral: true });
    const requiredRole = data.requirements?.role_id;
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (requiredRole && !member.roles.cache.has(requiredRole)) return interaction.reply({ content: "You do not have the required role.", ephemeral: true });
    const entries = [...new Set([...(Array.isArray(data.entries) ? data.entries : []), interaction.user.id])];
    await database.from("giveaways").update({ entries }).eq("id", id);
    return interaction.reply({ content: "You entered the giveaway.", ephemeral: true });
  }
  if (kind === "ticket") {
    requireDatabase();
    const { data, error } = await database.from("tickets").select("questions").eq("id", id).eq("guild_id", interaction.guildId).single();
    if (error) throw error;
    const modal = new ModalBuilder().setCustomId(`rustic:ticket-modal:${id}`).setTitle("Open a ticket");
    const questions = (Array.isArray(data.questions) ? data.questions : ["What do you need help with?"]).slice(0, 5);
    modal.addComponents(...questions.map((question, index) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(`answer_${index}`).setLabel(String(question).slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true),
    )));
    return interaction.showModal(modal);
  }
  if (kind === "ticket-claim") {
    await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, SendMessages: true });
    return interaction.reply(`${interaction.user} claimed this ticket.`);
  }
  if (kind === "ticket-close") {
    await interaction.reply("Closing this ticket in 5 seconds.");
    setTimeout(() => interaction.channel.delete("Rustic Utilities ticket closed").catch(console.error), 5_000);
  }
}

async function handleModal(interaction) {
  const parts = interaction.customId.split(":");
  if (parts[0] !== "rustic" || parts[1] !== "ticket-modal") return;
  requireDatabase();
  const ticketId = parts[2];
  const { data, error } = await database.from("tickets").select("*").eq("id", ticketId).eq("guild_id", interaction.guildId).single();
  if (error) throw error;
  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (data.support_role_id) overwrites.push({ id: data.support_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const channel = await interaction.guild.channels.create({
    name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 90),
    type: ChannelType.GuildText,
    parent: data.category_id || undefined,
    permissionOverwrites: overwrites,
    topic: `Rustic Utilities ticket ${ticketId} opened by ${interaction.user.id}`,
  });
  const answers = interaction.fields.fields.map((field, index) => `**${data.questions?.[index] || `Question ${index + 1}`}**\n${field.value}`).join("\n\n");
  await channel.send({
    content: `${interaction.user}${data.support_role_id ? ` <@&${data.support_role_id}>` : ""}`,
    embeds: [new EmbedBuilder().setTitle(`${data.emoji || "🎫"} ${data.type_name}`).setDescription(answers || "No details supplied.").setColor(0x5865f2)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rustic:ticket-claim:${ticketId}`).setLabel("Claim").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rustic:ticket-close:${ticketId}`).setLabel("Close").setStyle(ButtonStyle.Danger),
    )],
  });
  await audit(interaction.guildId, "ticket_opened", `${channel.id} by ${interaction.user.tag}`);
  await interaction.reply({ content: `Your ticket is ready: ${channel}`, ephemeral: true });
}

client.once(Events.ClientReady, async (readyClient) => {
  health.ready = true;
  health.readyAt = new Date().toISOString();
  health.guilds = readyClient.guilds.cache.size;
  console.log(`Rustic Utilities online as ${readyClient.user.tag} in ${health.guilds} guild(s)`);
  if (!clientId) {
    console.warn("Skipping slash command registration: CLIENT_ID is not set.");
    return;
  }
  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const route = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(clientId, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(clientId);
    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} slash commands${process.env.DISCORD_GUILD_ID ? " in the test guild" : " globally"}`);
  } catch (error) {
    console.error("Slash command registration failed:", safeError(error));
  }
});

client.on(Events.ShardDisconnect, (_event, shardId) => {
  health.ready = false;
  health.lastDisconnect = new Date().toISOString();
  console.warn(`Discord shard ${shardId} disconnected; discord.js will reconnect automatically.`);
});
client.on(Events.ShardReady, () => { health.ready = client.isReady(); });
client.on(Events.ShardError, (error, shardId) => console.error(`Discord shard ${shardId} error:`, safeError(error)));
client.on(Events.Error, (error) => console.error("Discord client error:", safeError(error)));

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) return;
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
  } catch (error) {
    const message = `Discord error: ${safeError(error)}`;
    console.error(message);
    await audit(interaction.guildId, "interaction_failed", message, "error");
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const config = await guildConfig(member.guild.id);
    if (config?.verification?.dm_on_join && config.verification.dm_message) await member.send(config.verification.dm_message).catch(() => undefined);
    await audit(member.guild.id, "member_joined", `${member.user.tag} (${member.id})`);
  } catch (error) { console.error("Member join handler failed:", safeError(error)); }
});
client.on(Events.GuildMemberRemove, (member) => void audit(member.guild.id, "member_left", `${member.user.tag} (${member.id})`));
client.on(Events.MessageDelete, (message) => { if (message.guildId) void audit(message.guildId, "message_deleted", `${message.channelId}/${message.id}`); });
client.on(Events.MessageUpdate, (_oldMessage, message) => { if (message.guildId) void audit(message.guildId, "message_edited", `${message.channelId}/${message.id}`); });
client.on(Events.ChannelCreate, (channel) => { if (channel.guildId) void audit(channel.guildId, "channel_created", `${channel.name} (${channel.id})`); });
client.on(Events.ChannelDelete, (channel) => { if (channel.guildId) void audit(channel.guildId, "channel_deleted", `${channel.name} (${channel.id})`); });

const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  response.status(200).json({
    status: health.ready ? "ok" : "connecting",
    discord: health.ready ? "connected" : "disconnected",
    database: hasDatabase ? "configured" : "fallback",
    uptimeSeconds: Math.floor(process.uptime()),
    guilds: client.guilds.cache.size,
    startedAt: health.startedAt,
    readyAt: health.readyAt,
    lastDisconnect: health.lastDisconnect,
  });
});
app.get("/", (_request, response) => response.type("text").send("Rustic Utilities bot service is running."));
const server = app.listen(Number(process.env.PORT) || 8080, "0.0.0.0", () => console.log(`Health server listening on port ${Number(process.env.PORT) || 8080}`));
server.on("error", (error) => console.error("Health server error:", safeError(error)));

let loginAttempts = 0;
async function connect() {
  try {
    loginAttempts += 1;
    await client.login(token);
    loginAttempts = 0;
  } catch (error) {
    const delay = Math.min(60_000, 2 ** Math.min(loginAttempts, 6) * 1_000);
    console.error(`Discord login failed; retrying in ${delay / 1000}s:`, safeError(error));
    setTimeout(() => void connect(), delay);
  }
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down cleanly.`);
  health.ready = false;
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("uncaughtException", (error) => console.error("Uncaught exception:", safeError(error)));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", safeError(error)));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void connect();