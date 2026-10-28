
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
    console.log(`Web sunucusu ${PORT} portunda çalışıyor.`);
});

// GİZLİ TOKEN
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
        throw new Error('DATABASE_URL ayarlanmamış!');
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

    console.log('Gakuran veritabanı tablolari hazir!');
}

// ELO TABLOSUNU OLUŞTUR
async function gakuranLeaderboardVerisi() {
    const sonuc = await pool.query(`
        SELECT roblox_username, elo
        FROM gakuran_players
        ORDER BY elo DESC, roblox_username ASC
    `);

    const satirlar = sonuc.rows.length
        ? sonuc.rows.map((oyuncu, index) =>
            `**${index + 1}.** ${oyuncu.roblox_username} — **${String(oyuncu.elo).padStart(2, '0')} Elo**`
        )
        : ['_Henüz kayıtlı oyuncu yok._'];

    const embed = new EmbedBuilder()
        .setColor(0xD4AF37)
        .setTitle('\u{1F3C6} GAKURAN ELO SIRALAMASI')
        .setDescription(satirlar.join('\n'))
        .setFooter({ text: 'Kazanan +15 Elo • Kaybeden -15 Elo' })
        .setTimestamp();

    const butonlar = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('gakuran_yenile')
            .setLabel('Yenile')
            .setEmoji('\u{1F504}')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('gakuran_kayit')
            .setLabel('Kayıt Ol')
            .setEmoji('\u{1F4DD}')
            .setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [butonlar] };
}

async function gakuranLeaderboardGonder(channel) {
    await channel.send(await gakuranLeaderboardVerisi());
}

// DISCORD ID’LERİ
const GUILD_ID = '1563977216713429045';
const VOICE_CHANNEL_ID = '1564354532295577780';
const ANNOUNCEMENT_CHANNEL_ID = '1563977218768769135';
const MEMBER_ROLE_ID = '1563985739903934636';
const STAFF_ROLE_ID = '1564893159736221706';
const LEADERBOARD_CHANNEL_ID = '1564893584312770630';
const APPLICATION_CHANNEL_ID = '1564893854342193172';

if (!TOKEN) {
    console.error('TOKEN eksik! Environment ayarlarıni kontrol et.');
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
        console.error('Ses baglantisi hatası:', error.message);
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
        console.log('Gakuran sistemi veritabanına bağlandı!');
    } catch (error) {
        console.error('Gakuran veritabanı hatası:', error.message);
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
        return message.reply('\u{274C} Bu işlem için yetkili rolü gerekiyor.');
    }

    const kanal = await client.channels
        .fetch(LEADERBOARD_CHANNEL_ID)
        .catch(() => null);

    if (!kanal || !kanal.isTextBased()) {
        return message.reply('\u{274C} Liderlik tablosu kanalı bulunamadı!');
    }

    await gakuranLeaderboardGonder(kanal);
    return message.reply('\u{2705} Gakuran liderlik tablosu oluşturuldu!');
}
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/);

    const command = args.shift()?.toLowerCase();

    if (!command) return;

    // PREFIX DEGISTIR
    if (command === 'prefix') {
        if (!message.member.permissions.has(
            PermissionsBitField.Flags.Administrator
        )) {
            return message.reply(
                '\u{274C} Bu komut için yönetici izni gerekiyor.'
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

            console.log(`Önek değişti: ${eskiPrefix} -> ${PREFIX}`);

            return message.reply(
                `\u{2705} Önek değişti: ${eskiPrefix} \u{2192} ${PREFIX}`
            );
        } catch (error) {
            PREFIX = eskiPrefix;
            console.error('Prefix kaydetme hatası:', error);

            return message.reply('\u{274C} Prefix kaydedilemedi!');
        }
    }

    // MESAJ SIL
    if (command === 'sil') {
        if (!message.member.permissions.has(
            PermissionsBitField.Flags.ManageMessages
        )) {
            return message.reply(
                '\u{274C} Mesajları Yönet iznin yok!'
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
                '\u{274C} Botun Mesajları Yönet izni yok!'
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
            console.error('Mesaj silme hatası:', error);
            await message.reply('\u{274C} Mesajlar silinemedi!');
        }

        return;
    }

    // DUYURU
    if (command === 'duyuru') {
        if (message.guild.id !== GUILD_ID) {
            return message.reply(
                '\u{274C} Bu komut bu sunucuda kullanılamaz.'
            );
        }

        const duyuruMetni = args.join(' ').trim();

        if (!duyuruMetni) {
            return message.reply(
                `\u{274C} Duyuru yaz! Örnek: ${PREFIX}duyuru Sunucu acildi.`
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
                '\u{274C} Duyuru kanalı bulunamadı!'
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
                '\u{274C} Botun duyuru kanalına mesaj gönderme izni yok!'
            );
        }

        try {
            await announcementChannel.send({
                content: duyuruMetni,
                allowedMentions: { parse: [] }
            });

            await message.delete().catch(() => null);

            console.log('Duyuru gönderildi!');
        } catch (error) {
            console.error('Duyuru hatası:', error);
        }

        return;
    }
});

// GAKURAN BUTONLARI VE BAŞVURU İŞLEMLERİ
client.on(Events.InteractionCreate, async interaction => {
    try {
        // KAYIT OL: modal ac
        if (interaction.isButton() && interaction.customId === 'gakuran_kayit') {
            if (!interaction.inGuild() || interaction.guildId !== GUILD_ID) {
                return interaction.reply({ content: 'Bu buton yalnızca Gakuran sunucusunda kullanılabilir.', flags: MessageFlags.Ephemeral });
            }
            if (interaction.channelId !== LEADERBOARD_CHANNEL_ID) {
                return interaction.reply({ content: 'Kayıt işlemini liderlik tablosu kanalındaki butondan başlat.', flags: MessageFlags.Ephemeral });
            }

            const modal = new ModalBuilder()
                .setCustomId('gakuran_kayit_modal')
                .setTitle('Gakuran Oyuncu Kaydı');
            const robloxInput = new TextInputBuilder()
                .setCustomId('roblox_username')
                .setLabel('Gakuran ismin')
                .setPlaceholder('Gakuran ismini yaz')
                .setStyle(TextInputStyle.Short)
                .setMinLength(2)
                .setMaxLength(30)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(robloxInput));
            return interaction.showModal(modal);
        }

        // LEADERBOARD YENİLE
        if (interaction.isButton() && interaction.customId === 'gakuran_yenile') {
            if (!interaction.inGuild() || interaction.guildId !== GUILD_ID || interaction.channelId !== LEADERBOARD_CHANNEL_ID) {
                return interaction.reply({ content: 'Bu buton yalnızca Gakuran liderlik tablosu kanalında kullanılabilir.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferUpdate();
            await interaction.message.edit(await gakuranLeaderboardVerisi());
            return;
        }

        // KAYIT FORMU GÖNDERİLDİ
        if (interaction.isModalSubmit() && interaction.customId === 'gakuran_kayit_modal') {
            if (!interaction.inGuild() || interaction.guildId !== GUILD_ID) {
                return interaction.reply({ content: 'Bu kayıt formu bu sunucuda kullanılamaz.', flags: MessageFlags.Ephemeral });
            }

            const gakuranName = interaction.fields.getTextInputValue('roblox_username').trim();
            if (!/^[\p{L}\p{N}_ ]{2,20}$/u.test(gakuranName)) {
                return interaction.reply({ content: 'Gakuran ismi 2-20 karakter olmalı; Türkçe harfler, harfler, rakamlar, boşluk ve _ kullanabilirsin.', flags: MessageFlags.Ephemeral });
            }
            const robloxUsername = gakuranName;

            const player = await pool.query('SELECT discord_id FROM gakuran_players WHERE discord_id = $1', [interaction.user.id]);
            if (player.rowCount) {
                return interaction.reply({ content: 'Zaten Gakuran sistemine kayıtlısın.', flags: MessageFlags.Ephemeral });
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
                    return interaction.reply({ content: 'Zaten bekleyen bir kayıt başvurun var.', flags: MessageFlags.Ephemeral });
                }
                throw error;
            }

            const applicationChannel = await client.channels.fetch(APPLICATION_CHANNEL_ID).catch(() => null);
            if (!applicationChannel || !applicationChannel.isTextBased() || !applicationChannel.guild || applicationChannel.guild.id !== GUILD_ID) {
                await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registration.rows[0].id]);
                return interaction.reply({ content: 'Başvuru kanalı bulunamadı. Yetkililere haber ver.', flags: MessageFlags.Ephemeral });
            }

            const appEmbed = new EmbedBuilder()
                .setColor(0xD4AF37)
                .setTitle('Yeni Gakuran Kayıt Başvurusu')
                .addFields(
                    { name: 'Discord', value: `${interaction.user.tag} (<@${interaction.user.id}>)` },
                    { name: 'Gakuran ismi', value: robloxUsername },
                    { name: 'Başvuru ID', value: String(registration.rows[0].id) }
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
            return interaction.reply({ content: 'Başvurun yetkililere gönderildi. Onaylandığında kayıt tamamlanacak.', flags: MessageFlags.Ephemeral });
        }

        // YETKİLİ BAŞVURU ONAY / RED
        if (interaction.isButton() && (interaction.customId.startsWith('gakuran_onayla_') || interaction.customId.startsWith('gakuran_reddet_'))) {
            const staffMember = interaction.inGuild() ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
            if (!staffMember || interaction.guildId !== GUILD_ID || !staffMember.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: 'Bu işlem yalnızca yetkililer tarafından yapılabilir.', flags: MessageFlags.Ephemeral });
            }

            const approve = interaction.customId.startsWith('gakuran_onayla_');
            const registrationId = interaction.customId.slice(approve ? 'gakuran_onayla_'.length : 'gakuran_reddet_'.length);
            if (!/^\d+$/.test(registrationId)) {
                return interaction.reply({ content: 'Başvuru numarası geçersiz.', flags: MessageFlags.Ephemeral });
            }

            const result = await pool.query("SELECT * FROM gakuran_registrations WHERE id = $1 AND status = 'pending'", [registrationId]);
            if (!result.rowCount) {
                return interaction.reply({ content: 'Bu başvuru artık beklemede değil veya bulunamadı.', flags: MessageFlags.Ephemeral });
            }
            const reg = result.rows[0];

            if (approve) {
                const duplicate = await pool.query('SELECT discord_id FROM gakuran_players WHERE discord_id = $1 OR LOWER(roblox_username) = LOWER($2)', [reg.discord_id, reg.roblox_username]);
                if (duplicate.rowCount) {
                    await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registrationId]);
                    await interaction.update({ content: 'Başvuru reddedildi: Discord hesabı veya Gakuran ismi zaten kayıtlı.', embeds: interaction.message.embeds, components: [] });
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
                await interaction.update({ content: `Başvuru ${interaction.user.tag} tarafından onaylandı.`, embeds: interaction.message.embeds, components: [] });
                const leaderboard = await client.channels.fetch(LEADERBOARD_CHANNEL_ID).catch(() => null);
                if (leaderboard?.isTextBased()) await leaderboard.send(await gakuranLeaderboardVerisi());
                const applicant = await client.users.fetch(reg.discord_id).catch(() => null);
                if (applicant) await applicant.send(`Gakuran kaydın onaylandı! Gakuran ismin: ${reg.roblox_username}`).catch(() => {});
                return;
            }

            await pool.query("UPDATE gakuran_registrations SET status = 'rejected' WHERE id = $1", [registrationId]);
            await interaction.update({ content: `Başvuru ${interaction.user.tag} tarafından reddedildi.`, embeds: interaction.message.embeds, components: [] });
            const applicant = await client.users.fetch(reg.discord_id).catch(() => null);
            if (applicant) await applicant.send('Gakuran kayıt başvurun reddedildi. Gerekirse yetkililerle iletişime geçebilirsin.').catch(() => {});
        }
    } catch (error) {
        console.error('Gakuran interaction hatası:', error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'İşlem sırasında hata oluştu. Yetkililer Render Logs bölümünü kontrol etsin.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
});

// HATALAR
client.on(Events.Error, error => {
    console.error('Discord istemci hatası:', error);
});

client.login(TOKEN).catch(error => {
    console.error('Discord girişi başarısız:', error.message);
});