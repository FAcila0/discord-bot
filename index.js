
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
    Client,
    GatewayIntentBits,
    Events,
    ChannelType,
    PermissionsBitField
} = require('discord.js');

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require('@discordjs/voice');

const express = require('express');

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
    console.log(`Web sunucusu ${PORT} portunda calisiyor.`);
});

// GIZLI TOKEN
const TOKEN = process.env.TOKEN;

// DISCORD ID'LERI
const GUILD_ID = '1563977216713429045';
const VOICE_CHANNEL_ID = '1564354532295577780';
const ANNOUNCEMENT_CHANNEL_ID = '1563977218768769135';

if (!TOKEN) {
    console.error('TOKEN eksik! Environment ayarlarini kontrol et.');
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
        console.error('Ses baglantisi hatasi:', error.message);
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

    await sesKanalinaBaglan();
});

// BUTUN KOMUTLAR
client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;
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
                '❌ Bu komut icin yonetici izni gerekiyor.'
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

            console.log(`Prefix degisti: ${eskiPrefix} -> ${PREFIX}`);

            return message.reply(
                `✅ Prefix degisti: ${eskiPrefix} → ${PREFIX}`
            );
        } catch (error) {
            PREFIX = eskiPrefix;
            console.error('Prefix kaydetme hatasi:', error);

            return message.reply('❌ Prefix kaydedilemedi!');
        }
    }

    // MESAJ SIL
    if (command === 'sil') {
        if (!message.member.permissions.has(
            PermissionsBitField.Flags.ManageMessages
        )) {
            return message.reply(
                '❌ Mesajlari Yonet iznin yok!'
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
                '❌ Botun Mesajlari Yonet izni yok!'
            );
        }

        try {
            const silinenler = await message.channel.bulkDelete(
                miktar,
                true
            );

            const bilgi = await message.channel.send(
                `🗑️ ${silinenler.size} mesaj silindi.`
            );

            setTimeout(() => {
                bilgi.delete().catch(() => {});
            }, 3000);
        } catch (error) {
            console.error('Mesaj silme hatasi:', error);
            await message.reply('❌ Mesajlar silinemedi!');
        }

        return;
    }

    // DUYURU
    if (command === 'duyuru') {
        if (message.guild.id !== GUILD_ID) {
            return message.reply(
                '❌ Bu komut bu sunucuda kullanilamaz.'
            );
        }

        const duyuruMetni = args.join(' ').trim();

        if (!duyuruMetni) {
            return message.reply(
                `❌ Duyuru yaz! Ornek: ${PREFIX}duyuru Sunucu acildi.`
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
                '❌ Duyuru kanali bulunamadi!'
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
                '❌ Botun duyuru kanalina mesaj gonderme izni yok!'
            );
        }

        try {
            await announcementChannel.send({
                content: duyuruMetni,
                allowedMentions: { parse: [] }
            });

            await message.delete().catch(() => null);

            console.log('Duyuru gonderildi!');
        } catch (error) {
            console.error('Duyuru hatasi:', error);
        }

        return;
    }
});

// HATALAR
client.on(Events.Error, error => {
    console.error('Discord istemci hatasi:', error);
});

client.login(TOKEN).catch(error => {
    console.error('Discord girisi basarisiz:', error.message);
});
