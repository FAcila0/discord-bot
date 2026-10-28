
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
    Client,
    GatewayIntentBits,
    Events,
    ChannelType,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require('@discordjs/voice');

const express = require('express');
const { Pool } = require('pg');

// PREFIX DOSYASI
const PREFIX_FILE = path.join(__dirname, 'prefix.json');

function prefixYukle() {
    try {
        const veri = JSON.parse(
            fs.readFileSync(PREFIX_FILE, 'utf8')
        );

        return typeof veri.prefix === 'string' &&
            veri.prefix.length > 0 &&
            veri.prefix.length <= 5
            ? veri.prefix
            : '!';
    } catch {
        fs.writeFileSync(
            PREFIX_FILE,
            JSON.stringify({ prefix: '!' }, null, 2)
        );
        return '!';
    }
}

function prefixKaydet(prefix) {
    fs.writeFileSync(
        PREFIX_FILE,
        JSON.stringify({ prefix }, null, 2)
    );
}

let PREFIX = prefixYukle();

// RENDER WEB SUNUCUSU
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send('Discord botu aktif!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web sunucusu ${PORT} portunda Ã§alÄ±ÅŸÄ±yor.`);
});

// GÄ°ZLÄ° TOKEN
const TOKEN = process.env.TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL?.includes('localhost')
        ? false
        : { rejectUnauthorized: false }
});

 // GAKURAN VERITABANI TABLOLARI
async function gakuranTablolariniOlustur() {
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL ayarlanmamÄ±ÅŸ!');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gakuran_players (
            discord_id TEXT PRIMARY KEY,
            discord_tag TEXT NOT NULL,
            roblox_username TEXT NOT NULL,
            elo INTEGER NOT NULL DEFAULT 0,
            approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gakuran_registrations (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            discord_id TEXT NOT NULL,
            discord_tag TEXT NOT NULL,
            roblox_username TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
            submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        gakuran_one_pending_registration
        ON gakuran_registrations (discord_id)
        WHERE status = 'pending';
    `);

    console.log('Gakuran veritabanÄ± tablolari hazir!');
}

// ELO TABLOSUNU OLUÅTUR
async function gakuranLeaderboardVerisi() {
    const sonuc = await pool.query(`
        SELECT roblox_username, elo
        FROM gakuran_players
        ORDER BY elo DESC, roblox_username ASC
    `);

    const satirlar = sonuc.rows.length
        ? sonuc.rows.map((oyuncu, index) =>
            `**${index + 1}.** ${oyuncu.roblox_username} â€” **${String(oyuncu.elo).padStart(2, '0')} Elo**`
        )
        : ['_HenÃ¼z kayÄ±tlÄ± oyuncu yok._'];

    const embed = new EmbedBuilder()
        .setColor(0xD4AF37)
        .setTitle('\u{1F3C6} GAKURAN ELO SIRALAMASI')
        .setDescription(satirlar.join('\n'))
        .setFooter({ text: 'Kazanan +15 Elo â€¢ Kaybeden -15 Elo' })
        .setTimestamp();

    const butonlar = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('gakuran_yenile')
            .setLabel('Yenile')
            .setEmoji('\u{1F504}')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('gakuran_kayit')
            .setLabel('KayÄ±t Ol')
            .setEmoji('\u{1F4DD}')
            .setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [butonlar] };
}

async function gakuranLeaderboardGonder(channel) {
    await channel.send(await gakuranLeaderboardVerisi());
}

// Var olan liderlik tablosunu dÃ¼zenle; her iÅŸlemde yeni mesaj oluÅŸturma.
async function gakuranLeaderboardGuncelle() {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error('Liderlik tablosu kanalÄ± bulunamadÄ±.');
    }

    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = messages?.find(message =>
        message.author.id === client.user.id &&
        message.embeds.some(embed => embed.title === 'ğŸ† GAKURAN ELO SIRALAMASI')
    );

    if (existing) {
        await existing.edit(await gakuranLeaderboardVerisi());
    } else {
        await channel.send(await gakuranLeaderboardVerisi());
    }
}

// DISCORD IDâ€™LERÄ°
const GUILD_ID = '1563977216713429045';
const VOICE_CHANNEL_ID = '1564354532295577780';
const ANNOUNCEMENT_CHANNEL_ID = '1563977218768769135';
const MEMBER_ROLE_ID = '1563985739903934636';
const STAFF_ROLE_ID = '1564893159736221706';
const LEADERBOARD_CHANNEL_ID = '1564893584312770630';
const APPLICATION_CHANNEL_ID = '1564893854342193172';

if (!TOKEN) {
    console.error('TOKEN eksik! Environment ayarlarÄ±ni kontrol et.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let voiceConnection = null;
let reconnecting = false;

// SES KANALINA BAGLAN
async function sesKanalinaBaglan() {
    const guild = client.guilds.cache.get(GUILD_ID);

    if (!guild) {
        console.error('Sunucu bulunamadi! GUILD_ID kontrol et.');
        return;
    }

    const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);

    if (
        !channel ||
        ![
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice
        ].includes(channel.type)
    ) {
        console.error('Ses kanali bulunamadi! ID kontrol et.');
        return;
    }

    if (
        voiceConnection &&
        voiceConnection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
        return;
    }

    voiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfMute: false,
        selfDeaf: false
    });

    voiceConnection.on('error', error => {
        console.error('Ses baglantisi hatasÄ±:', error.message);
    });

    voiceConnection.on(
        VoiceConnectionStatus.Disconnected,
        () => {
            if (reconnecting) return;

            reconnecting = true;

            console.log('Baglanti kesildi. Yeniden baglaniliyor...');

            setTimeout(() => {
                if (
                    voiceConnection &&
                    voiceConnection.state.status !==
                    VoiceConnectionStatus.Destroyed
                ) {
                    voiceConnection.destroy();
                }

                voiceConnection = null;
                reconnecting = false;

                if (client.isReady()) {
                    sesKanalinaBaglan().catch(console.error);
                }
            }, 5000);
        }
    );

    voiceConnection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`${channel.name} ses kanalina baglanildi!`);
    });
}

// BOT HAZIR
client.once(Events.ClientReady, async readyClient => {
    console.log(`${readyClient.user.tag} olarak giris yapildi!`);
    console.log(`Aktif prefix: ${PREFIX}`);

    try {
        await gakuranTablolariniOlustur();
        console.log('Gakuran sistemi veritabanÄ±na baÄŸlandÄ±!');
    } catch (error) {
        console.error('Gakuran veritabanÄ± hatasÄ±:', error.message);
    }

    await sesKanalinaBaglan();
});

// BUTUN KOMUTLAR
client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;
    // GAKURAN LEADERBOARD KURULUM KOMUTU
if (message.content === `${PREFIX}gakuran-kur`) {
    if (
        message.guild.id !== GUILD_ID ||
        !message.member.roles.cache.has(STAFF_ROLE_ID)
    ) {
        return message.reply('\u{274C} Bu iÅŸlem iÃ§in yetkili rolÃ¼ gerekiyor.');
    }

    const kanal = await client.channels
        .fetch(LEADERBOARD_CHANNEL_ID)
        .catch(() => null);

    if (!kanal || !kanal.isTextBased()) {
        return message.reply('\u{274C} Liderlik tablosu kanalÄ± bulunamadÄ±!');
    }

    await gakuranLeaderboardGuncelle();
    return message.reply('\u{2705} Gakuran liderlik tablosu gÃ¼ncellendi; yeni tablo mesajÄ± oluÅŸturulmadÄ±.');
}
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/);

    const command = args.shift()?.toLowerCase();

    if (!command) return;

    // YARDIM: mevcut komutlar ve kullanÄ±mlarÄ±
    if (command === 'yardÄ±m' || command === 'yardim' || command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle('ğŸ“– Bot KomutlarÄ±')
            .setDescription(`Aktif prefix: \`${PREFIX}\``)
            .addFields(
                { name: `${PREFIX}yardÄ±m`, value: 'Bu komut listesini gÃ¶sterir.' },
                { name: `${PREFIX}gakuran-kur`, value: 'Yetkililer: mevcut Elo tablosunu gÃ¼nceller.' },
                { name: `${PREFIX}gakuran-maÃ§`, value: 'Yetkililer: maÃ§ sonucu girme ve Elo gÃ¼ncelleme butonlarÄ±nÄ± gÃ¶sterir.' },
                { name: `${PREFIX}gakuran-oyuncu-sil`, value: 'Yetkililer: oyuncu silme butonunu gÃ¶sterir; oyuncu adÄ± formdan girilir.' },
                { name: `${PREFIX}duyuru <mesaj>`, value: 'Duyuru kanalÄ±na duyuru gÃ¶nderir.' },
                { name: `${PREFIX}mesaj <kanal kimliÄŸi> <mesaj>`, value: 'Yetkililer: belirtilen kanala istediÄŸin mesajÄ± gÃ¶nderir.' },
                { name: `${PREFIX}sil <1-100>`, value: 'MesajlarÄ± siler; MesajlarÄ± YÃ¶net izni gerekir.' },
                { name: `${PREFIX}prefix <yeni>`, value: 'Sunucu prefixini deÄŸiÅŸtirir; yÃ¶netici izni gerekir.' }
            )
            .setFooter({ text: 'Gakuran botu' });
        return message.reply({ embeds: [helpEmbed] });
    }

    // MAC BUTONLARI: yetkililer iÃ§in maÃ§ sonucu veya oyuncu silme iÅŸlemi
    if (command === 'gakuran-maÃ§' || command === 'gakuran-mac' || command === 'gakuran-oyuncu-sil') {
        if (message.guild.id !== GUILD_ID || !message.member.roles.cache.has(STAFF_ROLE_ID)) {
            return message.reply('âŒ Bu komut yalnÄ±zca Gakuran yetkilileri iÃ§indir.');
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('gakuran_mac_formu')
                .setLabel('MaÃ§ sonucu gir')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('ğŸ†'),
            new ButtonBuilder()
                .setCustomId('gakuran_oyuncu_sil_formu')
                .setLabel('Oyuncu sil')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('ğŸ—‘ï¸')
        );
        return message.reply({ content: 'Ä°ÅŸlem yapmak iÃ§in bir buton seÃ§:', components: [row] });
    }

    // ISTENILEN KANALA MESAJ GONDER (GAKURAN YETKILILERI)
    if (command === 'mesaj') {
        if (message.guild.id !== GUILD_ID || !message.member.roles.cache.has(STAFF_ROLE_ID)) {
            return message.reply('âŒ Bu komut yalnÄ±zca Gakuran yetkilileri iÃ§indir.');
        }

        const rawArgs = message.content.slice(PREFIX.length).trim();
        const komutVeDevami = rawArgs.replace(/^\S+\s*/, '');
        const eslesme = komutVeDevami.match(/^(\d{17,20})\s+([\s\S]+)$/);

        if (!eslesme) {
            return message.reply(`KullanÄ±m: \`${PREFIX}mesaj <kanal kimliÄŸi> <mesaj>\`\nÃ–rnek: \`${PREFIX}mesaj 123456789012345678 Merhaba herkese!\``);
        }

        const kanalID = eslesme[1];
        const gonderilecekMesaj = eslesme[2].trim();
        if (!gonderilecekMesaj || gonderilecekMesaj.length > 2000) {
            return message.reply('âŒ Mesaj boÅŸ olamaz ve 2000 karakteri geÃ§emez.');
        }

        const hedefKanal = await client.channels.fetch(kanalID).catch(() => null);
        if (!hedefKanal || !hedefKanal.isTextBased() || !('send' in hedefKanal)) {
            return message.reply('âŒ Bu kanal bulunamadÄ± veya mesaj gÃ¶nderilebilen bir metin kanalÄ± deÄŸil.');
        }

        try {
            await hedefKanal.send({ content: gonderilecekMesaj });
            return message.reply(`âœ… Mesaj <#${kanalID}> kanalÄ±na gÃ¶nderildi.`);
        } catch (error) {
            console.error('Mesaj gÃ¶nderme hatasÄ±:', error);
            return message.reply('âŒ Mesaj gÃ¶nderilemedi. Botun o kanalda Mesaj GÃ¶nderme izni olduÄŸundan emin ol.');
        }
    }

    // PREFIX DEGISTIR
    if (command === 'prefix') {
        if (!message.member.permissions.has(
            PermissionsBitField.Flags.Administrator
        )) {
            return message.reply(
                '\u{274C} Bu komut iÃ§in yÃ¶netici izni gerekiyor.'
            );
        }

        const yeniPrefix = args[0];

        if (!yeniPrefix || yeniPrefix.length > 5) {
            return message.reply(
                `Kullanim: ${PREFIX}prefix k!`
            );
        }

        const eskiPrefix = PREFIX;
        PREFIX = yeniPrefix;

        try {
            prefixKaydet(PREFIX);

            console.log(`Ã–nek deÄŸiÅŸti: ${eskiPrefix} -> ${PREFIX}`);

            return message.reply(
                `\u{2705} Ã–nek deÄŸiÅŸti: ${eskiPrefix} \u{2192} ${PREFIX}`
            );
        } catch (error) {
            PREFIX = eskiPrefix;
            console.error('Prefix kaydetme hatasÄ±:', error);

            return message.reply('\u{274C} Prefix kaydedilemedi!');
        }
    }

    // MESAJ SIL
    if (command === 'sil') {
        if (!message.member.permissions.has(
            PermissionsBitField.Flags.ManageMessages
        )) {
            return message.reply(
                '\u{274C} MesajlarÄ± YÃ¶net iznin yok!'
            );
        }

        const miktar = Number(args[0]);

        if (
            !Number.isInteger(miktar) ||
            miktar < 1 ||
            miktar > 100
        ) {
            return message.reply(
                `Kullanim: ${PREFIX}sil 10 (1-100)`
            );
        }

        const botMember = message.guild.members.me;

        if (!botMember ||
            !message.channel.permissionsFor(botMember)?.has(
                PermissionsBitField.Flags.ManageMessages
            )) {
            return message.reply(
                '\u{274C} Botun MesajlarÄ± YÃ¶net izni yok!'
            );
        }

        try {
            const silinenler = await message.channel.bulkDelete(
                miktar,
                true
            );

            const bilgi = await message.channel.send(
                `\u{1F5D1}\u{FE0F} ${silinenler.size} mesaj silindi.`
            );

            setTimeout(() => {
                bilgi.delete().catch(() => {});
            }, 3000);
        } catch (error) {
            console.error('Mesaj silme hatasÄ±:', error);
            await message.reply('\u{274C} Mesajlar silinemedi!');
        }

        return;
    }

    // DUYURU
    if (command === 'duyuru') {
        if (message.guild.id !== GUILD_ID) {
            return message.reply(
                '\u{274C} Bu komut bu sunucuda kullanÄ±lamaz.'
            );
        }

        const duyuruMetni = args.join(' ').trim();

        if (!duyuruMetni) {
            return message.reply(
                `\u{274C} Duyuru yaz! Ã–rnek: ${PREFIX}duyuru Sunucu acildi.`
            );
        }

        const announcementChannel =
            await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID)
                .catch(() => null);

        if (
            !announcementChannel ||
            !announcementChannel.isTextBased() ||
            !announcementChannel.guild ||
            announcementChannel.guild.id !== GUILD_ID
        ) {
            return message.reply(
                '\u{274C} Duyuru kanalÄ± bulunamadÄ±!'
            );
        }

        const botMember = message.guild.members.me;
        const permissions =
            announcementChannel.permissionsFor(botMember);

        if (
            !permissions ||
            !permissions.has(PermissionsBitField.Flags.ViewChannel) ||
            !permissions.has(PermissionsBitField.Flags.SendMessages)
        ) {
            return message.reply(
                '\u{274C} Botun duyuru kanalÄ±na mesaj gÃ¶nderme izni yok!'
            );
        }

        try {
            await announcementChannel.send({
                content: duyuruMetni,
                allowedMentions: { parse: [] }
            });

            await message.delete().catch(() => null);

            console.log('Duyuru gÃ¶nderildi!');
        } catch (error) {
            console.error('Duyuru hatasÄ±:', error);
        }

        return;
    }
});

// GAKURAN BUTONLARI VE BAÅVURU Ä°ÅLEMLERÄ°
client.on(Events.InteractionCreate, async interaction => {
    try {
        // OYUNCU SÄ°LME FORMUNU AÃ‡
        if (interaction.isButton() && interaction.customId === 'gakuran_oyuncu_sil_formu') {
            const staffMember = interaction.inGuild()
                ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
                : null;
            if (!staffMember || interaction.guildId !== GUILD_ID || !staffMember.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: 'Bu iÅŸlem yalnÄ±zca Gakuran yetkilileri tarafÄ±ndan yapÄ±labilir.', flags: MessageFlags.Ephemeral });
            }
            const modal = new ModalBuilder()
                .setCustomId('gakuran_oyuncu_sil_modal')
                .setTitle('Gakuran Oyuncu Sil');
            const nameInput = new TextInputBuilder()
                .setCustomId('oyuncu_ismi')
                .setLabel('Silinecek Gakuran oyuncu ismi')
                .setPlaceholder('Tablodaki oyuncu adÄ±nÄ± yaz')
                .setStyle(TextInputStyle.Short)
                .setMinLength(2)
                .setMaxLength(30)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
            return interaction.showModal(modal);
        }

        // OYUNCU SÄ°LME FORMU GÃ–NDERÄ°LDÄ°
        if (interaction.isModalSubmit() && interaction.customId === 'gakuran_oyuncu_sil_modal') {
            const staffMember = interaction.inGuild()
                ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
                : null;
            if (!staffMember || interaction.guildId !== GUILD_ID || !staffMember.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: 'Bu iÅŸlem yalnÄ±zca Gakuran yetkilileri tarafÄ±ndan yapÄ±labilir.', flags: MessageFlags.Ephemeral });
            }
            const playerName = interaction.fields.getTextInputValue('oyuncu_ismi').trim();
            const deleted = await pool.query(
                'DELETE FROM gakuran_players WHERE LOWER(roblox_username) = LOWER($1) RETURNING discord_id, roblox_username',
                [playerName]
            );
            if (!deleted.rowCount) {
                return interaction.reply({ content: `âŒ "${playerName}" isimli kayÄ±tlÄ± oyuncu bulunamadÄ±.`, flags: MessageFlags.Ephemeral });
            }
            await gakuranLeaderboardGuncelle();
            return interaction.reply({ content: `âœ… **${deleted.rows[0].roblox_username}** oyuncusu Elo tablosundan silindi.`, flags: MessageFlags.Ephemeral });
        }

        // MAÃ‡ FORMUNU AÃ‡
        if (interaction.isButton() && interaction.customId === 'gakuran_mac_formu') {
            const staffMember = interaction.inGuild()
                ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
                : null;
            if (!staffMember || interaction.guildId !== GUILD_ID || !staffMember.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: 'Bu iÅŸlem yalnÄ±zca Gakuran yetkilileri tarafÄ±ndan yapÄ±labilir.', flags: MessageFlags.Ephemeral });
            }

            const modal = new ModalBuilder()
                .setCustomId('gakuran_mac_modal')
                .setTitle('Gakuran MaÃ§ Sonucu');

            const winnerInput = new TextInputBuilder()
                .setCustomId('kazanan')
                .setLabel('KazananÄ±n Gakuran ismi')
                .setPlaceholder('Kazanan oyuncunun kayÄ±tlÄ± adÄ±')
                .setStyle(TextInputStyle.Short)
                .setMinLength(2)
                .setMaxLength(20)
                .setRequired(true);

            const loserInput = new TextInputBuilder()
                .setCustomId('kaybeden')
                .setLabel('Kaybedenin Gakuran ismi')
                .setPlaceholder('Kaybeden oyuncunun kayÄ±tlÄ± adÄ±')
                .setStyle(TextInputStyle.Short)
                .setMinLength(2)
                .setMaxLength(20)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(winnerInput),
                new ActionRowBuilder().addComponents(loserInput)
            );
            return interaction.showModal(modal);
        }

        // MAÃ‡ SONUCUNU KAYDET: kazanana +15, kaybedene -15
        if (interaction.isModalSubmit() && interaction.customId === 'gakuran_mac_modal') {
            const staffMember = interaction.inGuild()
                ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
                : null;
            if (!staffMember || interaction.guildId !== GUILD_ID || !staffMember.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: 'Bu iÅŸlem yalnÄ±zca Gakuran yetkilileri tarafÄ±ndan yapÄ±labilir.', flags: MessageFlags.Ephemeral });
            }

            const winnerName = interaction.fields.getTextInputValue('kazanan').trim();
            const loserName = interaction.fields.getTextInputValue('kaybeden').trim();

            if (winnerName.toLocaleLowerCase('tr-TR') === loserName.toLocaleLowerCase('tr-TR')) {
                return interaction.reply({ content: 'Kazanan ve kaybeden farklÄ± oyuncular olmalÄ±.', flags: MessageFlags.Ephemeral });
            }

            const dbClient = await pool.connect();
            let winner;
            let loser;
            try {
                await dbClient.query('BEGIN');
                const winnerResult = await dbClient.query(
                    'SELECT discord_id, roblox_username, elo FROM gakuran_players WHERE LOWER(roblox_username) = LOWER($1) FOR UPDATE',
                    [winnerName]
                );
                const loserResult = await dbClient.query(
                    'SELECT discord_id, roblox_username, elo FROM gakuran_players WHERE LOWER(roblox_username) = LOWER($1) FOR UPDATE',
                    [loserName]
                );

                if (!winnerResult.rowCount || !loserResult.rowCount) {
                    await dbClient.query('ROLLBACK');
                    return interaction.reply({ content: 'Oyunculardan biri bulunamadÄ±. Ä°simleri tablodaki Gakuran isimleriyle aynÄ± yaz.', flags: MessageFlags.Ephemeral });
                }

                winner = winnerResult.rows[0];
                loser = loserResult.rows[0];

                if (winner.discord_id === loser.discord_id) {
                    await dbClient.query('ROLLBACK');
                    return interaction.reply({ content: 'Kazanan ve kaybeden farklÄ± oyuncular olmalÄ±.', flags: MessageFlags.Ephemeral });
                }

                await dbClient.query('UPDATE gakuran_players SET elo = elo + 15 WHERE discord_id = $1', [winner.discord_id]);
                await dbClient.query('UPDATE gakuran_players SET elo = elo - 15 WHERE discord_id = $1', [loser.discord_id]);
                await dbClient.query('COMMIT');
            } catch (error) {
                await dbClient.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                dbClient.release();
            }

            await gakuranLeaderboardGuncelle();
            return interaction.reply({
                content: `âœ… MaÃ§ sonucu kaydedildi!\nğŸ† Kazanan: **${winner.roblox_username}** (+15 Elo)\nğŸ“‰ Kaybeden: **${loser.roblox_username}** (-15 Elo)\nNegatif Elo mÃ¼mkÃ¼ndÃ¼r.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // KAYIT OL: modal ac
        if (interaction.isButton() && interaction.customId === 'gakuran_kayit') {
            if (!interaction.inGuild() || interaction.guildId !== GUILD_ID) {
                return interaction.reply({ content: 'Bu buton yalnÄ±zca Gakuran sunucusunda kullanÄ±labilir.', flags: MessageFlags.Ephemeral });
            }
            if (interaction.channelId !== LEADERBOARD_CHANNEL_ID) {
                return interaction.reply({ content: 'KayÄ±t iÅŸlemini liderlik tablosu kanalÄ±ndaki butondan baÅŸlat.', flags: MessageFlags.Ephemeral });
            }

            const modal = new ModalBuilder()
                .setCustomId('gakuran_kayit_modal')
                .setTitle('Gakuran Oyuncu KaydÄ±');
            const robloxInput = new TextInputBuilder()
                .setCustomId('roblox_username')
                .setLabel('Gakuran ismin')
                .setPlaceholder('Gakuran ismini yaz (en az 2 karakter)')
                .setStyle(TextInputStyle.Short)
                .setMinLength(2)
                .setMaxLength(20)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(robloxInput));
            return interaction.showModal(modal);
        }

        // LEADERBOARD YENÄ°LE
        if (interaction.isButton() && interaction.customId === 'gakuran_yenile') {
            if (!interaction.inGuild() || interaction.guildId !== GUILD_ID || interaction.channelId !== LEADERBOARD_CHANNEL_ID) {
                return interaction.reply({ content: 'Bu buton yalnÄ±zca Gakuran liderlik tablosu kanalÄ±nda kullanÄ±labilir.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferUpdate();
            await interaction.message.edit(await gakuranLeaderboardVerisi());
            return;
        }

        // KAYIT FORMU GÃ–NDERÄ°LDÄ°
        if (interaction.isModalSubmit() && interaction.customId === 'gakuran_kayit_modal') {
            if (!interaction.inGuild() || interaction.guildId !== GUILD_ID) {
                return interaction.reply({ content: 'Bu kayÄ±t formu bu sunucuda kullanÄ±lamaz.', flags: MessageFlags.Ephemeral });
            }

            const gakuranName = interaction.fields.getTextInputValue('roblox_username').trim();
            if (!/^[\p{L}\p{N}_ ]{2,20}$/u.test(gakuranName)) {
                return interaction.reply({ content: 'Gakuran ismi 2-20 karakter olmalÄ±; TÃ¼rkÃ§e harfler, harfler, rakamlar, boÅŸluk ve _ kullanabilirsin.', flags: MessageFlags.Ephemeral });
            }
            const robloxUsername = gakuranName;

            const player = await pool.query('SELECT discord_id FROM gakuran_players WHERE discord_id = $1', [interaction.user.id]);
            if (player.rowCount) {
                return interaction.reply({ content: 'Zaten Gakuran sistemine kayÄ±tlÄ±sÄ±n.', flags: MessageFlags.Ephemeral });
            }

            let registration;
            try {
                registration = await pool.query(
                    `INSERT INTO gakuran_registrations (discord_id, discord_tag, roblox_username)
                     VALUES ($1, $2, $3) RETURNING id`,
                    [interaction.user.id, interaction.user.tag, robloxUsername]
                );
            } catch (error) {
                if (error.code === '23505') {
                    return interaction.reply({ content: 'Zaten bekleyen bir kayÄ±t baÅŸvurun var.', flags: MessageFlags.Ephemeral });
                }
                throw error;
            }

            const applicationChannel = await client.channels.fetch(APPLICATION_CHANNEL_ID).catch(() => null);
            if (!applicationChannel || !applicationChannel.isTextBased() || !applicationChannel.guild || applicationChannel.guild.id !== GUILD_ID) {
                await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registration.rows[0].id]);
                return interaction.reply({ content: 'BaÅŸvuru kanalÄ± bulunamadÄ±. Yetkililere haber ver.', flags: MessageFlags.Ephemeral });
            }

            const appEmbed = new EmbedBuilder()
                .setColor(0xD4AF37)
                .setTitle('Yeni Gakuran KayÄ±t BaÅŸvurusu')
                .addFields(
                    { name: 'Discord', value: `${interaction.user.tag} (<@${interaction.user.id}>)` },
                    { name: 'Gakuran ismi', value: robloxUsername },
                    { name: 'BaÅŸvuru ID', value: String(registration.rows[0].id) }
                )
                .setTimestamp();
            const appButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`gakuran_onayla_${registration.rows[0].id}`).setLabel('Onayla').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`gakuran_reddet_${registration.rows[0].id}`).setLabel('Reddet').setStyle(ButtonStyle.Danger)
            );

            try {
                await applicationChannel.send({ embeds: [appEmbed], components: [appButtons] });
            } catch (error) {
                await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registration.rows[0].id]);
                throw error;
            }
            return interaction.reply({ content: 'BaÅŸvurun yetkililere gÃ¶nderildi. OnaylandÄ±ÄŸÄ±nda kayÄ±t tamamlanacak.', flags: MessageFlags.Ephemeral });
        }

        // YETKÄ°LÄ° BAÅVURU ONAY / RED
        if (interaction.isButton() && (interaction.customId.startsWith('gakuran_onayla_') || interaction.customId.startsWith('gakuran_reddet_'))) {
            const staffMember = interaction.inGuild() ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
            if (!staffMember || interaction.guildId !== GUILD_ID || !staffMember.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: 'Bu iÅŸlem yalnÄ±zca yetkililer tarafÄ±ndan yapÄ±labilir.', flags: MessageFlags.Ephemeral });
            }

            const approve = interaction.customId.startsWith('gakuran_onayla_');
            const registrationId = interaction.customId.slice(approve ? 'gakuran_onayla_'.length : 'gakuran_reddet_'.length);
            if (!/^\d+$/.test(registrationId)) {
                return interaction.reply({ content: 'BaÅŸvuru numarasÄ± geÃ§ersiz.', flags: MessageFlags.Ephemeral });
            }

            const result = await pool.query("SELECT * FROM gakuran_registrations WHERE id = $1 AND status = 'pending'", [registrationId]);
            if (!result.rowCount) {
                return interaction.reply({ content: 'Bu baÅŸvuru artÄ±k beklemede deÄŸil veya bulunamadÄ±.', flags: MessageFlags.Ephemeral });
            }
            const reg = result.rows[0];

            if (approve) {
                const duplicate = await pool.query('SELECT discord_id FROM gakuran_players WHERE discord_id = $1 OR LOWER(roblox_username) = LOWER($2)', [reg.discord_id, reg.roblox_username]);
                if (duplicate.rowCount) {
                    await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registrationId]);
                    await interaction.update({ content: 'BaÅŸvuru reddedildi: Discord hesabÄ± veya Gakuran ismi zaten kayÄ±tlÄ±.', embeds: interaction.message.embeds, components: [] });
                    return;
                }
                const dbClient = await pool.connect();
                try {
                    await dbClient.query('BEGIN');
                    await dbClient.query('INSERT INTO gakuran_players (discord_id, discord_tag, roblox_username, elo) VALUES ($1, $2, $3, 0)', [reg.discord_id, reg.discord_tag, reg.roblox_username]);
                    await dbClient.query("UPDATE gakuran_registrations SET status = 'approved' WHERE id = $1", [registrationId]);
                    await dbClient.query('COMMIT');
                } catch (error) {
                    await dbClient.query('ROLLBACK');
                    throw error;
                } finally {
                    dbClient.release();
                }
                await interaction.update({ content: `BaÅŸvuru ${interaction.user.tag} tarafÄ±ndan onaylandÄ±.`, embeds: interaction.message.embeds, components: [] });
                await gakuranLeaderboardGuncelle();
                const applicant = await client.users.fetch(reg.discord_id).catch(() => null);
                if (applicant) await applicant.send(`Gakuran kaydÄ±n onaylandÄ±! Gakuran ismin: ${reg.roblox_username}`).catch(() => {});
                return;
            }

            await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registrationId]);
            await interaction.update({ content: `BaÅŸvuru ${interaction.user.tag} tarafÄ±ndan reddedildi.`, embeds: interaction.message.embeds, components: [] });
            const applicant = await client.users.fetch(reg.discord_id).catch(() => null);
            if (applicant) await applicant.send('Gakuran kayÄ±t baÅŸvurun reddedildi. Gerekirse yetkililerle iletiÅŸime geÃ§ebilirsin.').catch(() => {});
        }
    } catch (error) {
        console.error('Gakuran interaction hatasÄ±:', error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Ä°ÅŸlem sÄ±rasÄ±nda hata oluÅŸtu. Yetkililer Render Logs bÃ¶lÃ¼mÃ¼nÃ¼ kontrol etsin.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
});

// HATALAR
client.on(Events.Error, error => {
    console.error('Discord istemci hatasÄ±:', error);
});

client.login(TOKEN).catch(error => {
    console.error('Discord giriÅŸi baÅŸarÄ±sÄ±z:', error.message);
});