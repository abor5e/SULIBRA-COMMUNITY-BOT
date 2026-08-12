const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
    AttachmentBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const transcripts = require('discord-html-transcripts');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.get('/', (req, res) => res.send('Sulibra Bot is running!'));
app.listen(3000, () => console.log('Web server listening on port 3000'));

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN) { console.error('Missing TOKEN'); process.exit(1); }
if (!CLIENT_ID) { console.error('Missing CLIENT_ID'); process.exit(1); }

const configsDir = path.join(__dirname, 'configs');
if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });

function defaultGuildConfig() {
    return { logsChannelId: null, staffRoleId: null, categoryRoles: {}, channelCategories: {}, channelOwners: {}, ticketCount: 0, totalTickets: 0, closedCount: 0, claims: {}, channelClaimants: {}, pendingClosures: {}, ticketRatings: {} };
}

function loadGuildConfig(guildId) {
    const file = path.join(configsDir, guildId + '.json');
    if (!fs.existsSync(file)) return defaultGuildConfig();
    try { return Object.assign(defaultGuildConfig(), JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { return defaultGuildConfig(); }
}

function saveGuildConfig(guildId, data) {
    try {
        if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });
        fs.writeFileSync(path.join(configsDir, guildId + '.json'), JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('saveGuildConfig error:', err.message);
    }
}

async function buildTranscript(channel, ticketNum) {
    return await transcripts.createTranscript(channel, {
        filename: 'ticket-' + ticketNum + '.html',
        saveImages: false,
        poweredBy: false
    });
}

function incrementGuildTicket(guildId) {
    const cfg = loadGuildConfig(guildId);
    cfg.ticketCount = (cfg.ticketCount || 0) + 1;
    cfg.totalTickets = (cfg.totalTickets || 0) + 1;
    saveGuildConfig(guildId, cfg);
    return cfg.totalTickets;
}

// ─── بنرات الأقسام ────────────────────────────────────────────────────────────
const categoryBanners = {
    'technical':     'sulibra-banner.png',
    'report-admin':  'sulibra-banner.png',
    'report-member': 'sulibra-banner.png',
    'purchase':      'sulibra-banner.png',
    'inquiry':       'sulibra-banner.png'
};

function getBannerPath(category) {
    const fileName = categoryBanners[category];
    if (!fileName) return null;
    const candidates = [
        path.join(__dirname, 'assets', fileName),
        path.join(process.cwd(), 'assets', fileName)
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function ratingComponents(ticketNumber, ownerId) {
    return [
        new ActionRowBuilder().addComponents(
            [1, 2, 3, 4, 5].map(stars =>
                new ButtonBuilder()
                    .setCustomId('ticket-rating:' + ticketNumber + ':' + ownerId + ':' + stars)
                    .setLabel(String(stars))
                    .setEmoji('⭐')
                    .setStyle(stars >= 4 ? ButtonStyle.Success : stars === 3 ? ButtonStyle.Secondary : ButtonStyle.Danger)
            )
        )
    ];
}

async function finalizeTicketClosure(guild, channel, guildId, closure) {
    const cfg = loadGuildConfig(guildId);
    const pending = cfg.pendingClosures && cfg.pendingClosures[channel.id];
    if (!pending || pending.finalized) return;

    pending.finalized = true;
    const rating = cfg.ticketRatings && cfg.ticketRatings[channel.id];
    const transcript = await buildTranscript(channel, closure.ticketNumber).catch(() => null);

    if (cfg.logsChannelId) {
        const logsChannel = guild.channels.cache.get(cfg.logsChannelId);
        if (logsChannel) {
            const ratingValue = rating
                ? '⭐'.repeat(rating.stars) + ' (' + rating.stars + '/5)'
                : 'لم يتم التقييم';
            const reasonValue = rating && rating.reason ? rating.reason.slice(0, 1024) : 'لم يكتب سبباً';
            const logPayload = {
                embeds: [new EmbedBuilder()
                    .setTitle('📋 سجل التذكرة #' + closure.ticketNumber)
                    .addFields(
                        { name: '👤 الصاحب', value: closure.ownerId ? '<@' + closure.ownerId + '>' : 'غير معروف', inline: true },
                        { name: '🔒 أُغلقت بواسطة', value: '<@' + closure.closerId + '>', inline: true },
                        { name: '📁 القناة', value: channel.name, inline: true },
                        { name: '⭐ التقييم', value: ratingValue, inline: true },
                        { name: '📝 السبب', value: reasonValue }
                    )
                    .setColor(0xED4245)
                    .setTimestamp()]
            };
            if (transcript) logPayload.files = [transcript];
            await logsChannel.send(logPayload).catch(err => console.error('Rating log error:', err.message));
        }
    }

    cfg.closedCount = (cfg.closedCount || 0) + 1;
    if (cfg.channelClaimants) delete cfg.channelClaimants[channel.id];
    if (cfg.channelOwners) delete cfg.channelOwners[channel.id];
    delete cfg.pendingClosures[channel.id];
    delete cfg.ticketRatings[channel.id];
    saveGuildConfig(guildId, cfg);

    await channel.delete('أُغلقت بواسطة ' + (closure.closerTag || 'الإدارة')).catch(() => null);
}

const commands = [
    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('إرسال لوحة التذاكر إلى هذه القناة')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('setup-logs')
        .setDescription('تحديد قناة إرسال سجلات التذاكر المغلقة')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(opt =>
            opt.setName('channel').setDescription('القناة المستهدفة').addChannelTypes(ChannelType.GuildText).setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('setup-staff')
        .setDescription('تحديد رتبة الإدارة العامة')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addRoleOption(opt => opt.setName('role').setDescription('رتبة الإدارة').setRequired(true)),

    new SlashCommandBuilder()
        .setName('setup-category')
        .setDescription('تخصيص رتبة لقسم تذاكر معين')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('ticket-stats')
        .setDescription('عرض إحصائيات التذاكر')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('reset-stats')
        .setDescription('إعادة تعيين إحصائيات التذاكر')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('remove-user')
        .setDescription('إزالة مستخدم من قناة التذكرة الحالية')
        .addUserOption(opt => opt.setName('user').setDescription('المستخدم المراد إزالته').setRequired(true)),

    new SlashCommandBuilder()
        .setName('close-ticket')
        .setDescription('إغلاق التذكرة الحالية وحفظ السجل'),

    new SlashCommandBuilder()
        .setName('add-user')
        .setDescription('إضافة مستخدم إلى قناة التذكرة الحالية')
        .addUserOption(opt => opt.setName('user').setDescription('المستخدم المراد إضافته').setRequired(true)),

    new SlashCommandBuilder()
        .setName('rename-ticket')
        .setDescription('إعادة تسمية قناة التذكرة الحالية')
        .addStringOption(opt => opt.setName('name').setDescription('الاسم الجديد').setRequired(true)),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('عرض جميع أوامر الإدارة')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('staff-help')
        .setDescription('عرض أوامر الإدارة'),
].map(cmd => cmd.toJSON());

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on('error', err => console.error('Client error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message));

client.once('ready', async () => {
    console.log('Sulibra جاهز: ' + client.user.tag);
    try {
        const rest = new REST().setToken(TOKEN);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('تم تسجيل الأوامر.');
    } catch (err) {
        console.error('فشل تسجيل الأوامر:', err.message);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) return;
    const guildId = interaction.guild.id;

    // ─── أوامر السلاش ─────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // ── /ticket ──────────────────────────────────────────────────────────
        if (commandName === 'ticket') {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('ticket-menu')
                .setPlaceholder('اختر نوع طلبك...')
                .addOptions([
                    { label: 'الـدعـم الـفـنـي 〡🎫', value: 'technical' },
                    { label: 'بـلاغ عـن اداري 〡🏛️', value: 'report-admin' },
                    { label: 'بـلاغ عـن عـضـو〡🏛️', value: 'report-member' },
                    { label: 'شـراء〡💸', value: 'purchase' },
                    { label: 'اسـتـفسـار〡📝', value: 'inquiry' },
                ]);

            const row = new ActionRowBuilder().addComponents(menu);

            // بنر اللوحة الرئيسية
            const mainBannerPaths = [
                path.join(__dirname, 'assets', 'sulibra-banner.png'),
                path.join(process.cwd(), 'assets', 'sulibra-banner.png')
            ];
            const mainBannerPath = mainBannerPaths.find(p => fs.existsSync(p)) || null;

            try {
                if (mainBannerPath) {
                    const attachment = new AttachmentBuilder(mainBannerPath, { name: 'sulibra-banner.png' });
                    await interaction.channel.send({ files: [attachment], components: [row] });
                } else {
                    await interaction.channel.send({ components: [row] });
                }
                await interaction.reply({ content: '✅ تم إرسال لوحة التذاكر.', flags: 64 });
            } catch (err) {
                console.error('[ticket panel error]', err.message);
                await interaction.reply({ content: '❌ خطأ: `' + err.message + '`', flags: 64 });
            }
            return;
        }

        // ── /setup-logs ───────────────────────────────────────────────────────
        if (commandName === 'setup-logs') {
            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
            const cfg = loadGuildConfig(guildId);
            cfg.logsChannelId = targetChannel.id;
            saveGuildConfig(guildId, cfg);
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('✅ تم تعيين <#' + targetChannel.id + '> كقناة سجلات.').setColor(0x57F287)], flags: 64 });
            return;
        }

        // ── /setup-staff ──────────────────────────────────────────────────────
        if (commandName === 'setup-staff') {
            const role = interaction.options.getRole('role');
            const cfg = loadGuildConfig(guildId);
            cfg.staffRoleId = role.id;
            saveGuildConfig(guildId, cfg);
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('✅ تم تعيين <@&' + role.id + '> كرتبة إدارة.').setColor(0x57F287)], flags: 64 });
            return;
        }

        // ── /setup-category ───────────────────────────────────────────────────
        if (commandName === 'setup-category') {
            const catMenu = new StringSelectMenuBuilder()
                .setCustomId('setup-category-select')
                .setPlaceholder('اختر قسماً...')
                .addOptions([
                    { label: 'الـدعـم الـفـنـي 〡🎫', value: 'technical' },
                    { label: 'بـلاغ عـن اداري 〡🏛️', value: 'report-admin' },
                    { label: 'بـلاغ عـن عـضـو〡🏛️', value: 'report-member' },
                    { label: 'شـراء〡💸', value: 'purchase' },
                    { label: 'اسـتـفسـار〡📝', value: 'inquiry' },
                ]);
            await interaction.reply({
                embeds: [new EmbedBuilder().setTitle('⚙️ تخصيص رتبة للقسم').setDescription('اختر القسم:').setColor(0xE8B923)],
                components: [new ActionRowBuilder().addComponents(catMenu)],
                flags: 64
            });
            return;
        }

        // ── /ticket-stats ─────────────────────────────────────────────────────
        if (commandName === 'ticket-stats') {
            const cfg = loadGuildConfig(guildId);
            const sortedClaims = Object.entries(cfg.claims || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
            let claimsValue = 'لا توجد بيانات بعد';
            if (sortedClaims.length > 0) claimsValue = sortedClaims.map((e, i) => (i + 1) + '. <@' + e[0] + '> — **' + e[1] + '** استلامات').join('\n');
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('📊 إحصائيات التذاكر — Sulibra')
                    .addFields(
                        { name: '📥 إجمالي المفتوحة', value: String(cfg.ticketCount || 0), inline: true },
                        { name: '🔒 إجمالي المغلقة', value: String(cfg.closedCount || 0), inline: true },
                        { name: '🟡 النشطة حالياً', value: String(Math.max(0, (cfg.ticketCount || 0) - (cfg.closedCount || 0))), inline: true },
                        { name: '👤 أفضل الإدارة', value: claimsValue }
                    )
                    .setColor(0xE8B923).setTimestamp()],
                flags: 64
            });
            return;
        }

        // ── /reset-stats ──────────────────────────────────────────────────────
        if (commandName === 'reset-stats') {
            const cfg = loadGuildConfig(guildId);
            cfg.ticketCount = 0; cfg.closedCount = 0; cfg.claims = {};
            saveGuildConfig(guildId, cfg);
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('✅ تم إعادة تعيين الإحصائيات.').setColor(0xED4245).setTimestamp()], flags: 64 });
            return;
        }

        // ── /close-ticket ─────────────────────────────────────────────────────
        if (commandName === 'close-ticket') {
            const channel = interaction.channel;
            const cfg = loadGuildConfig(guildId);
            const closer = interaction.member;
            const isAdmin = closer.permissions.has(PermissionFlagsBits.Administrator);
            const hasStaffRole = cfg.staffRoleId && closer.roles.cache.has(cfg.staffRoleId);
            if (!isAdmin && !hasStaffRole) { await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', flags: 64 }); return; }
            const claimantId = cfg.channelClaimants && cfg.channelClaimants[channel.id];
            if (claimantId && !isAdmin && closer.id !== claimantId) {
                await interaction.reply({ content: '❌ فقط عضو الإدارة الذي استلم التذكرة (<@' + claimantId + '>) أو الإدارة يمكنهم الإغلاق.', flags: 64 });
                return;
            }
            const channelName = channel.name;
            const ticketNum = channelName.replace(/[^0-9]/g, '') || '?';
            const ownerId = cfg.channelOwners && cfg.channelOwners[channel.id];
            if (cfg.pendingClosures && cfg.pendingClosures[channel.id]) {
                await interaction.reply({ content: '⏳ تم طلب التقييم مسبقاً لهذه التذكرة.', flags: 64 });
                return;
            }
            try { await interaction.deferReply(); } catch { return; }

            const closeCfg = loadGuildConfig(guildId);
            if (!closeCfg.pendingClosures) closeCfg.pendingClosures = {};
            closeCfg.pendingClosures[channel.id] = {
                ticketNumber: ticketNum,
                ownerId,
                closerId: closer.id,
                closerTag: closer.user.tag,
                startedAt: Date.now()
            };
            saveGuildConfig(guildId, closeCfg);

            if (isAdmin) {
                const adminCloseEmbed = new EmbedBuilder()
                    .setTitle('🔒 تم إغلاق التذكرة')
                    .setDescription('تم إغلاق التذكرة بواسطة الإدارة.')
                    .setColor(0xED4245)
                    .setTimestamp();
                await interaction.editReply({ embeds: [adminCloseEmbed] });
                setTimeout(() => finalizeTicketClosure(channel.guild, channel, guildId, closeCfg.pendingClosures[channel.id]), 3000);
                return;
            }

            const ratingEmbed = new EmbedBuilder()
                .setTitle('⭐ قيّم تجربتك')
                .setDescription('اختر عدد النجوم، وبعدها اكتب سبب التقييم في النموذج الذي سيظهر لك.')
                .setColor(0xE8B923)
                .setTimestamp();
            const ratingMessage = await interaction.editReply({
                content: ownerId ? '<@' + ownerId + '>' : null,
                embeds: [ratingEmbed],
                components: ratingComponents(ticketNum, ownerId)
            });
            closeCfg.pendingClosures[channel.id].ratingMessageId = ratingMessage.id;
            saveGuildConfig(guildId, closeCfg);
            setTimeout(() => finalizeTicketClosure(channel.guild, channel, guildId, closeCfg.pendingClosures[channel.id] || {}), 60000);
            return;
        }

        // ── /remove-user ──────────────────────────────────────────────────────
        if (commandName === 'remove-user') {
            const channel = interaction.channel;
            const cfg = loadGuildConfig(guildId);
            const requester = interaction.member;
            const isAdmin = requester.permissions.has(PermissionFlagsBits.Administrator);
            const hasStaffRole = cfg.staffRoleId && requester.roles.cache.has(cfg.staffRoleId);
            if (!isAdmin && !hasStaffRole) { await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', flags: 64 }); return; }
            const targetUser = interaction.options.getUser('user');
            const ownerId = cfg.channelOwners && cfg.channelOwners[channel.id];
            const claimantId = cfg.channelClaimants && cfg.channelClaimants[channel.id];
            if (targetUser.id === ownerId) { await interaction.reply({ content: '❌ لا يمكنك إزالة صاحب التذكرة.', flags: 64 }); return; }
            if (targetUser.id === claimantId) { await interaction.reply({ content: '❌ لا يمكنك إزالة عضو الإدارة المستلمة.', flags: 64 }); return; }
            if (!channel.permissionOverwrites.cache.get(targetUser.id)) { await interaction.reply({ content: '❌ هذا المستخدم لم يُضف إلى التذكرة.', flags: 64 }); return; }
            await channel.permissionOverwrites.delete(targetUser.id);
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('✅ تم إزالة <@' + targetUser.id + '> من التذكرة.').setColor(0xED4245)] });
            return;
        }

        // ── /add-user ─────────────────────────────────────────────────────────
        if (commandName === 'add-user') {
            const channel = interaction.channel;
            const cfg = loadGuildConfig(guildId);
            const requester = interaction.member;
            const isAdmin = requester.permissions.has(PermissionFlagsBits.Administrator);
            const hasStaffRole = cfg.staffRoleId && requester.roles.cache.has(cfg.staffRoleId);
            const isTicketOwner = cfg.channelOwners && cfg.channelOwners[channel.id] === requester.id;
            if (!isAdmin && !hasStaffRole && !isTicketOwner) { await interaction.reply({ content: 'هذا الأمر للإدارة وصاحب التذكرة فقط.', flags: 64 }); return; }
            const targetUser = interaction.options.getUser('user');
            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            if (!targetMember) { await interaction.reply({ content: '❌ العضو غير موجود في السيرفر.', flags: 64 }); return; }
            await channel.permissionOverwrites.edit(targetMember.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('✅ تم إضافة <@' + targetUser.id + '> إلى التذكرة.').setColor(0x57F287)] });
            return;
        }

        // ── /rename-ticket ────────────────────────────────────────────────────
        if (commandName === 'rename-ticket') {
            const channel = interaction.channel;
            const cfg = loadGuildConfig(guildId);
            const requester = interaction.member;
            const isAdmin = requester.permissions.has(PermissionFlagsBits.Administrator);
            const hasStaffRole = cfg.staffRoleId && requester.roles.cache.has(cfg.staffRoleId);
            const claimantId = cfg.channelClaimants && cfg.channelClaimants[channel.id];
            if (!isAdmin && !hasStaffRole && requester.id !== claimantId) { await interaction.reply({ content: '❌ فقط الإدارة المستلمة أو الإدارة يمكنهم إعادة التسمية.', flags: 64 }); return; }
            const newName = interaction.options.getString('name').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').slice(0, 100);
            if (!newName) { await interaction.reply({ content: '❌ اسم غير صالح.', flags: 64 }); return; }
            const oldName = channel.name;
            await channel.setName(newName).catch(() => null);
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('✏️ تم التغيير من `' + oldName + '` إلى `' + newName + '`.').setColor(0xE8B923).setTimestamp()] });
            return;
        }

        // ── /help ─────────────────────────────────────────────────────────────
        if (commandName === 'help') {
            await interaction.reply({
                embeds: [new EmbedBuilder().setTitle('📋 أوامر الإدارة — Sulibra').addFields(
                    { name: '`/ticket`', value: 'إرسال لوحة التذاكر' },
                    { name: '`/setup-logs`', value: 'تحديد قناة السجلات' },
                    { name: '`/setup-staff`', value: 'تحديد رتبة الإدارة العامة' },
                    { name: '`/setup-category`', value: 'تخصيص رتبة لكل قسم' },
                    { name: '`/close-ticket`', value: 'إغلاق التذكرة وحفظ السجل' },
                    { name: '`/rename-ticket`', value: 'إعادة تسمية قناة التذكرة' },
                    { name: '`/add-user`', value: 'إضافة مستخدم للتذكرة' },
                    { name: '`/remove-user`', value: 'إزالة مستخدم من التذكرة' },
                    { name: '`/ticket-stats`', value: 'الإحصائيات' },
                    { name: '`/reset-stats`', value: 'إعادة تعيين الإحصائيات' },
                ).setColor(0xE8B923).setFooter({ text: 'Sulibra — أوامر الإدارة' }).setTimestamp()],
                flags: 64
            });
            return;
        }

        // ── /staff-help ───────────────────────────────────────────────────────
        if (commandName === 'staff-help') {
            const cfg = loadGuildConfig(guildId);
            const member = interaction.member;
            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
            const hasStaffRole = cfg.staffRoleId && member.roles.cache.has(cfg.staffRoleId);
            const hasCategoryRole = cfg.categoryRoles && Object.values(cfg.categoryRoles).some(rid => member.roles.cache.has(rid));
            if (!isAdmin && !hasStaffRole && !hasCategoryRole) { await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', flags: 64 }); return; }
            await interaction.reply({
                embeds: [new EmbedBuilder().setTitle('📋 أوامر الإدارة').setDescription('الأوامر المتاحة داخل التذاكر:').addFields(
                    { name: '🔵 استلام التذكرة', value: 'اضغط زر **استلام** لتسجيلك كالمسؤول عنها' },
                    { name: '`/close-ticket`', value: 'إغلاق التذكرة — للإدارة المستلمة فقط' },
                    { name: '`/rename-ticket`', value: 'إعادة تسمية القناة — للإدارة المستلمة فقط' },
                    { name: '`/add-user`', value: 'إضافة شخص للتذكرة' },
                    { name: '`/remove-user`', value: 'إزالة شخص من التذكرة' },
                ).setColor(0xE8B923).setFooter({ text: 'استلام التذكرة أولاً قبل أي إجراء' }).setTimestamp()],
                flags: 64
            });
            return;
        }

        return;
    }

    // ─── قائمة التذاكر ────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket-menu') {
        try { await interaction.deferReply({ flags: 64 }); } catch { return; }

        try {
            const cfg = loadGuildConfig(guildId);
            const ticketNumber = incrementGuildTicket(guildId);
            const guild = interaction.guild;
            const member = interaction.member;
            const selectedValue = interaction.values[0];

            const categoryLabels = {
                'technical':     'الـدعـم الـفـنـي 〡🎫',
                'report-admin':  'بـلاغ عـن اداري 〡🏛️',
                'report-member': 'بـلاغ عـن عـضـو〡🏛️',
                'purchase':      'شـراء〡💸',
                'inquiry':       'اسـتـفسـار〡📝'
            };

            const categoryEmojis = {
                'technical':     '🎫',
                'report-admin':  '🏛️',
                'report-member': '🏛️',
                'purchase':      '💸',
                'inquiry':       '📝'
            };

            const channelName = 'ticket-' + ticketNumber;
            const categoryRoleId = cfg.categoryRoles && cfg.categoryRoles[selectedValue];
            const activeRoleId = categoryRoleId || cfg.staffRoleId;

            const permissionOverwrites = [
                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
            ];

            if (activeRoleId) {
                permissionOverwrites.push({ id: activeRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
            }

            guild.roles.cache.filter(r => r.permissions.has(PermissionFlagsBits.Administrator) && r.id !== activeRoleId).forEach(r => {
                permissionOverwrites.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
            });

            const channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, permissionOverwrites });

            const ticketEmbed = new EmbedBuilder()
                .setTitle((categoryEmojis[selectedValue] || '🎫') + ' تذكرة #' + ticketNumber)
                .addFields(
                    { name: 'القسم', value: categoryLabels[selectedValue] || selectedValue, inline: true },
                    { name: 'فُتحت بواسطة', value: '<@' + member.id + '>', inline: true },
                    { name: 'الحالة', value: 'مفتوحة — في انتظار الإدارة', inline: true }
                )
                .setDescription('أهلاً بك في **Sulibra**! يرجى شرح طلبك وسيتولى أحد الإدارة مساعدتك قريباً.')
                .setColor(0xE8B923)
                .setTimestamp();

            const claimButton = new ButtonBuilder()
                .setCustomId('claim-ticket:' + ticketNumber + ':' + member.id)
                .setLabel('استلام التذكرة')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('👤');

            const closeButton = new ButtonBuilder()
                .setCustomId('close-ticket:' + ticketNumber + ':' + member.id)
                .setLabel('إغلاق التذكرة')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒');

            const pings = ['<@' + member.id + '>'];
            if (activeRoleId) pings.push('<@&' + activeRoleId + '>');

            const openMsgPayload = { content: pings.join(' '), embeds: [ticketEmbed], components: [new ActionRowBuilder().addComponents(claimButton, closeButton)] };
            await channel.send(openMsgPayload);

            const openCfg = loadGuildConfig(guildId);
            if (!openCfg.channelOwners) openCfg.channelOwners = {};
            openCfg.channelOwners[channel.id] = member.id;
            if (!openCfg.channelCategories) openCfg.channelCategories = {};
            openCfg.channelCategories[channel.id] = selectedValue;
            saveGuildConfig(guildId, openCfg);

            await interaction.editReply({ content: 'تم فتح تذكرتك: <#' + channel.id + '>' });

        } catch (err) {
            console.error('[ticket-create error]', err);
            try { await interaction.editReply({ content: '❌ خطأ: `' + (err && err.message ? err.message : String(err)) + '`' }); } catch {}
        }

        return;
    }

    // ─── setup-category: الخطوة 1 ─────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup-category-select') {
        const selectedCat = interaction.values[0];
        const categoryLabels = {
            'technical': 'الـدعـم الـفـنـي 〡🎫',
            'report-admin': 'بـلاغ عـن اداري 〡🏛️',
            'report-member': 'بـلاغ عـن عـضـو〡🏛️',
            'purchase': 'شـراء〡💸',
            'inquiry': 'اسـتـفسـار〡📝'
        };
        const roleMenu = new RoleSelectMenuBuilder().setCustomId('setup-category-role:' + selectedCat).setPlaceholder('اختر رتبة...');
        await interaction.update({
            embeds: [new EmbedBuilder().setTitle('⚙️ تخصيص رتبة').setDescription('القسم: **' + categoryLabels[selectedCat] + '**\n\nاختر الرتبة:').setColor(0xE8B923)],
            components: [new ActionRowBuilder().addComponents(roleMenu)]
        });
        return;
    }

    // ─── setup-category: الخطوة 2 ─────────────────────────────────────────────
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('setup-category-role:')) {
        const selectedCat = interaction.customId.split(':')[1];
        const selectedRole = interaction.roles.first();
        const categoryLabels = {
            'technical': 'الـدعـم الـفـنـي 〡🎫',
            'report-admin': 'بـلاغ عـن اداري 〡🏛️',
            'report-member': 'بـلاغ عـن عـضـو〡🏛️',
            'purchase': 'شـراء〡💸',
            'inquiry': 'اسـتـفسـار〡📝'
        };
        const cfg = loadGuildConfig(guildId);
        if (!cfg.categoryRoles) cfg.categoryRoles = {};
        cfg.categoryRoles[selectedCat] = selectedRole.id;
        saveGuildConfig(guildId, cfg);
        await interaction.update({
            embeds: [new EmbedBuilder().setTitle('✅ تم التخصيص').setDescription('القسم **' + categoryLabels[selectedCat] + '** → <@&' + selectedRole.id + '>').setColor(0x57F287).setTimestamp()],
            components: []
        });
        return;
    }

    // ─── تقييم التذكرة: اختيار النجوم ──────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('ticket-rating:')) {
        const parts = interaction.customId.split(':');
        const ticketNumber = parts[1];
        const ownerId = parts[2];
        const stars = Number(parts[3]);
        const channel = interaction.channel;
        const cfg = loadGuildConfig(guildId);
        const pending = cfg.pendingClosures && cfg.pendingClosures[channel.id];

        if (!pending || pending.ownerId !== interaction.user.id || ownerId !== interaction.user.id) {
            await interaction.reply({ content: '❌ التقييم متاح لصاحب التذكرة فقط.', flags: 64 });
            return;
        }

        if (!cfg.ticketRatings) cfg.ticketRatings = {};
        cfg.ticketRatings[channel.id] = {
            stars,
            ownerId: interaction.user.id,
            ratedAt: Date.now()
        };
        saveGuildConfig(guildId, cfg);

        const modal = new ModalBuilder()
            .setCustomId('ticket-rating-reason:' + channel.id + ':' + ticketNumber)
            .setTitle('سبب التقييم');
        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('السبب:')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('اكتب سبب تقييمك...')
            .setRequired(false)
            .setMaxLength(1000);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
        return;
    }

    // ─── تقييم التذكرة: حفظ السبب ──────────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket-rating-reason:')) {
        const parts = interaction.customId.split(':');
        const channelId = parts[1];
        const channel = interaction.guild.channels.cache.get(channelId) || interaction.channel;
        const cfg = loadGuildConfig(guildId);
        const pending = cfg.pendingClosures && cfg.pendingClosures[channelId];
        const rating = cfg.ticketRatings && cfg.ticketRatings[channelId];

        if (!pending || pending.ownerId !== interaction.user.id || !rating) {
            await interaction.reply({ content: '❌ انتهت صلاحية نموذج التقييم.', flags: 64 });
            return;
        }

        rating.reason = interaction.fields.getTextInputValue('reason').trim() || 'لم يكتب سبباً';
        rating.submittedAt = Date.now();
        saveGuildConfig(guildId, cfg);

        await interaction.reply({ content: '✅ تم تسجيل تقييمك، شكراً لك.', flags: 64 });
        setTimeout(() => finalizeTicketClosure(interaction.guild, channel, guildId, pending), 3000);
        return;
    }

    // ─── زر الاستلام ────────────────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('claim-ticket:')) {
        const parts = interaction.customId.split(':');
        const ticketNumber = parts[1];
        const ownerId = parts[2];
        const claimant = interaction.member;
        const channel = interaction.channel;
        const cfg = loadGuildConfig(guildId);

        const isAdmin = claimant.permissions.has(PermissionFlagsBits.Administrator);
        const channelCat = cfg.channelCategories && cfg.channelCategories[channel.id];
        const catRoleId = channelCat && cfg.categoryRoles && cfg.categoryRoles[channelCat];
        const hasStaffRole = (cfg.staffRoleId && claimant.roles.cache.has(cfg.staffRoleId)) || (catRoleId && claimant.roles.cache.has(catRoleId));

        if (!isAdmin && !hasStaffRole) {
            try { await interaction.reply({ content: 'فقط الإدارة المخصصة لهذا القسم يمكنها الاستلام.', flags: 64 }); } catch {}
            return;
        }

        try {
            const updatedTicketEmbed = interaction.message.embeds[0]
                ? EmbedBuilder.from(interaction.message.embeds[0])
                : new EmbedBuilder();
            const updatedFields = (interaction.message.embeds[0]?.fields || []).map(field =>
                field.name === 'الحالة'
                    ? { name: 'الحالة', value: 'مستلمة بواسطة <@' + claimant.id + '>', inline: field.inline ?? true }
                    : { name: field.name, value: field.value, inline: field.inline ?? false }
            );
            updatedTicketEmbed
                .setFields(updatedFields)
                .setColor(0x57F287);

            await interaction.message.edit({
                embeds: [updatedTicketEmbed],
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close-ticket:' + ticketNumber + ':' + ownerId + ':' + claimant.id).setLabel('إغلاق التذكرة').setStyle(ButtonStyle.Danger).setEmoji('🔒'))]
            });

            const claimCfg = loadGuildConfig(guildId);
            if (!claimCfg.claims) claimCfg.claims = {};
            claimCfg.claims[claimant.id] = (claimCfg.claims[claimant.id] || 0) + 1;
            if (!claimCfg.channelClaimants) claimCfg.channelClaimants = {};
            claimCfg.channelClaimants[channel.id] = claimant.id;
            saveGuildConfig(guildId, claimCfg);

            const claimOverwrites = [
                { id: channel.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                { id: claimant.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }
            ];

            const activeStaffRoleId = (channelCat && claimCfg.categoryRoles && claimCfg.categoryRoles[channelCat]) || claimCfg.staffRoleId;
            if (activeStaffRoleId && activeStaffRoleId !== claimant.id) {
                claimOverwrites.push({ id: activeStaffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] });
            }

            channel.guild.roles.cache.filter(r => r.permissions.has(PermissionFlagsBits.Administrator)).forEach(r => {
                claimOverwrites.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
            });

            await channel.permissionOverwrites.set(claimOverwrites);

            const claimEmbed = new EmbedBuilder()
                .setDescription('👤 تم الاستلام بواسطة <@' + claimant.id + '>.\nسيتولى طلبك.')
                .setColor(0xE8B923)
                .setTimestamp();
            const claimReplyPayload = { embeds: [claimEmbed] };
            await interaction.reply(claimReplyPayload);
        } catch (err) { console.error('Claim error:', err.message); }
        return;
    }

    // ─── زر الإغلاق ───────────────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('close-ticket:')) {
        const parts = interaction.customId.split(':');
        const ticketNumber = parts[1];
        const ownerId = parts[2];
        const claimantId = parts[3] || null;
        const closer = interaction.member;
        const channel = interaction.channel;
        const cfg = loadGuildConfig(guildId);

        const isAdmin = closer.permissions.has(PermissionFlagsBits.Administrator);
        const closeChannelCat = cfg.channelCategories && cfg.channelCategories[channel.id];
        const closeCatRoleId = closeChannelCat && cfg.categoryRoles && cfg.categoryRoles[closeChannelCat];
        const hasStaffRole = (cfg.staffRoleId && closer.roles.cache.has(cfg.staffRoleId)) || (closeCatRoleId && closer.roles.cache.has(closeCatRoleId));

        if (!isAdmin && !hasStaffRole) {
            try { await interaction.reply({ content: 'فقط الإدارة يمكنها إغلاق التذكرة.', flags: 64 }); } catch {}
            return;
        }

        if (claimantId && !isAdmin && closer.id !== claimantId) {
            try { await interaction.reply({ content: '❌ فقط عضو الإدارة المستلمة (<@' + claimantId + '>) أو الإدارة يمكنهم الإغلاق.', flags: 64 }); } catch {}
            return;
        }

        if (cfg.pendingClosures && cfg.pendingClosures[channel.id]) {
            try { await interaction.reply({ content: '⏳ تم طلب التقييم مسبقاً لهذه التذكرة.', flags: 64 }); } catch {}
            return;
        }

        try { await interaction.deferReply(); } catch { return; }

        await interaction.message.edit({ components: [] }).catch(() => null);

        const closeCfg = loadGuildConfig(guildId);
        if (!closeCfg.pendingClosures) closeCfg.pendingClosures = {};
        closeCfg.pendingClosures[channel.id] = {
            ticketNumber,
            ownerId,
            closerId: closer.id,
            closerTag: closer.user.tag,
            startedAt: Date.now()
        };
        saveGuildConfig(guildId, closeCfg);

        if (isAdmin) {
            const adminCloseEmbed = new EmbedBuilder()
                .setTitle('🔒 تم إغلاق التذكرة')
                .setDescription('تم إغلاق التذكرة بواسطة الإدارة.')
                .setColor(0xED4245)
                .setTimestamp();
            await interaction.editReply({ embeds: [adminCloseEmbed] });
            setTimeout(() => finalizeTicketClosure(channel.guild, channel, guildId, closeCfg.pendingClosures[channel.id]), 3000);
            return;
        }

        const ratingEmbed = new EmbedBuilder()
            .setTitle('⭐ قيّم تجربتك')
            .setDescription('اختر عدد النجوم، وبعدها اكتب سبب التقييم في النموذج الذي سيظهر لك.')
            .setColor(0xE8B923)
            .setTimestamp();
        const ratingMessage = await interaction.editReply({
            content: ownerId ? '<@' + ownerId + '>' : null,
            embeds: [ratingEmbed],
            components: ratingComponents(ticketNumber, ownerId)
        });
        closeCfg.pendingClosures[channel.id].ratingMessageId = ratingMessage.id;
        saveGuildConfig(guildId, closeCfg);
        setTimeout(() => finalizeTicketClosure(channel.guild, channel, guildId, closeCfg.pendingClosures[channel.id] || {}), 60000);
        return;
    }
});

client.login(TOKEN);
