import type { SupportedLocale } from "@lurkloot/shared/models";

// Store artwork copy is kept separate from product UI messages.
export interface StoreArtworkCopy {
  tagline: string;
  stories: {
    // The opening shot: what Lurkloot does for you, beside the full popup.
    queue: StoreArtworkStory & { steps: string[] };
    games: StoreArtworkStory & { description: string };
    kick: StoreArtworkStory;
    // How the idle watchlist works, beside the real list, then what it earns.
    watchlist: StoreArtworkStory & {
      feature: string;
      howItWorks: string[];
      earning: string;
      earns: { twitch: string[]; kick: string[] };
    };
    free: StoreArtworkStory & { description: string };
  };
  // What Lurkloot supports: on both platforms, then on each one alone.
  platforms: { both: string[]; twitch: string[]; kick: string[] };
  promo: { lines: string[]; steps: [string, string][] };
}

interface StoreArtworkStory {
  number: string;
  title: string;
}

export const STORE_ARTWORK_COPY: Record<SupportedLocale, StoreArtworkCopy> = {
  "en": {
    "tagline": "LESS WATCHING. MORE REWARDS.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farm drops\nwithout lifting\na finger.",
        "steps": [
          "Finds a live stream",
          "Tracks your progress",
          "Claims your rewards"
        ]
      },
      "games": {
        "number": "02",
        "title": "Your games.\nYour priorities.",
        "description": "Lurkloot farms every game by default. Want only some? Tick them, star favourites, block the rest."
      },
      "kick": {
        "number": "03",
        "title": "Much more\nthan drops."
      },
      "watchlist": {
        "number": "04",
        "feature": "Idle watchlist",
        "title": "Keep watching\nwhen there are no drops.",
        "howItWorks": [
          "Pick your favourite streamers",
          "Nothing to farm? The first live one is watched",
          "Switches as they go live or offline"
        ],
        "earning": "Keeps earning",
        "earns": {
          "twitch": [
            "Channel points"
          ],
          "kick": [
            "Daily rewards",
            "Level XP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farm everything.\nWatch nothing.",
        "description": "Always free and open source. No ads, no subscriptions."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Badges",
        "Idle watchlist"
      ],
      "twitch": [
        "Channel points",
        "Twitch extensions"
      ],
      "kick": [
        "Daily reward",
        "Account level"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatic rewards.",
        "Supports selected Twitch extensions."
      ],
      "steps": [
        [
          "Drops on autopilot",
          "Find a stream. Track progress. Claim rewards."
        ],
        [
          "Twitch extensions, too",
          "Optional support for selected extension rewards."
        ],
        [
          "Your watch order",
          "Pin campaigns. Star games. Pick your channels."
        ]
      ]
    }
  },
  "es": {
    "tagline": "MENOS ESPERA. MÁS RECOMPENSAS.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farmea drops\nsin mover\nun dedo.",
        "steps": [
          "Encuentra un directo",
          "Sigue tu progreso",
          "Reclama recompensas"
        ]
      },
      "games": {
        "number": "02",
        "title": "Tus juegos.\nTus prioridades.",
        "description": "Lurkloot farmea todos los juegos por defecto. ¿Solo algunos? Márcalos, destaca favoritos y bloquea el resto."
      },
      "kick": {
        "number": "03",
        "title": "Mucho más\nque drops."
      },
      "watchlist": {
        "number": "04",
        "feature": "Lista de reserva",
        "title": "Sigue viendo\ncuando no haya drops.",
        "howItWorks": [
          "Elige tus streamers favoritos",
          "¿Nada que farmear? Se ve el primer canal en directo",
          "Cambia al empezar o terminar la emisión"
        ],
        "earning": "Sigue ganando",
        "earns": {
          "twitch": [
            "Puntos de canal"
          ],
          "kick": [
            "Recompensa diaria",
            "XP de nivel"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farmea todo.\nNo mires nada.",
        "description": "Siempre gratis y de código abierto. Sin anuncios ni suscripciones."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Insignias",
        "Lista de reserva"
      ],
      "twitch": [
        "Puntos de canal",
        "Extensiones de Twitch"
      ],
      "kick": [
        "Recompensa diaria",
        "Nivel de Kick"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Recompensas automáticas.",
        "Compatible con algunas extensiones de Twitch."
      ],
      "steps": [
        [
          "Drops en automático",
          "Busca una transmisión. Sigue el progreso. Reclama recompensas."
        ],
        [
          "También extensiones de Twitch",
          "Soporte opcional para recompensas de algunas extensiones."
        ],
        [
          "Tu orden de visionado",
          "Fija campañas. Marca juegos. Elige tus canales."
        ]
      ]
    }
  },
  "fr": {
    "tagline": "MOINS D’ATTENTE. PLUS DE RÉCOMPENSES.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farmez sans\nlever le\npetit doigt.",
        "steps": [
          "Trouve un direct",
          "Suit votre avancée",
          "Réclame les gains"
        ]
      },
      "games": {
        "number": "02",
        "title": "Vos jeux.\nVos priorités.",
        "description": "Lurkloot farme tous les jeux par défaut. Certains seulement ? Cochez, étoilez vos favoris, bloquez le reste."
      },
      "kick": {
        "number": "03",
        "title": "Bien plus\nque des drops."
      },
      "watchlist": {
        "number": "04",
        "feature": "Liste d'attente",
        "title": "Continuez à regarder\nsans drops.",
        "howItWorks": [
          "Choisissez vos streamers préférés",
          "Rien à farmer ? La première chaîne en direct est regardée",
          "Bascule quand ils passent en direct ou hors ligne"
        ],
        "earning": "Continue de gagner",
        "earns": {
          "twitch": [
            "Points de chaîne"
          ],
          "kick": [
            "Bonus quotidien",
            "XP de niveau"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farmez tout.\nNe regardez rien.",
        "description": "Toujours gratuit et open source. Sans pub, sans abonnement."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Badges",
        "Liste d'attente"
      ],
      "twitch": [
        "Points de chaîne",
        "Extensions Twitch"
      ],
      "kick": [
        "Récompense quotidienne",
        "Niveau Kick"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Récompenses automatiques.",
        "Compatible avec certaines extensions Twitch."
      ],
      "steps": [
        [
          "Des drops en automatique",
          "Trouvez un stream. Suivez la progression. Récupérez vos gains."
        ],
        [
          "Les extensions Twitch aussi",
          "Prise en charge facultative de certaines récompenses d’extensions."
        ],
        [
          "Votre ordre de visionnage",
          "Épinglez des campagnes. Ajoutez des favoris. Choisissez vos chaînes."
        ]
      ]
    }
  },
  "it": {
    "tagline": "MENO ATTESA. PIÙ RICOMPENSE.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farma i drop\nsenza muovere\nun dito.",
        "steps": [
          "Trova una diretta",
          "Segue i progressi",
          "Riscuote i premi"
        ]
      },
      "games": {
        "number": "02",
        "title": "I tuoi giochi.\nLe tue priorità.",
        "description": "Lurkloot farma tutti i giochi di default. Solo alcuni? Selezionali, segna i preferiti, blocca il resto."
      },
      "kick": {
        "number": "03",
        "title": "Molto di più\ndei drop."
      },
      "watchlist": {
        "number": "04",
        "feature": "Lista di riserva",
        "title": "Continua a guardare\nsenza drop.",
        "howItWorks": [
          "Scegli i tuoi streamer preferiti",
          "Niente da farmare? Si guarda il primo canale in diretta",
          "Cambia quando vanno in diretta o offline"
        ],
        "earning": "Continua a guadagnare",
        "earns": {
          "twitch": [
            "Punti canale"
          ],
          "kick": [
            "Premio giornaliero",
            "XP livello"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farma tutto.\nNon guardare nulla.",
        "description": "Sempre gratuito e open source. Niente pubblicità, niente abbonamenti."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Badge",
        "Lista di riserva"
      ],
      "twitch": [
        "Punti canale",
        "Estensioni Twitch"
      ],
      "kick": [
        "Ricompensa giornaliera",
        "Livello Kick"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Ricompense automatiche.",
        "Supporta alcune estensioni Twitch."
      ],
      "steps": [
        [
          "Drop in automatico",
          "Trova uno stream. Segui i progressi. Riscatta le ricompense."
        ],
        [
          "Anche le estensioni Twitch",
          "Supporto facoltativo alle ricompense di alcune estensioni."
        ],
        [
          "Il tuo ordine di visione",
          "Fissa campagne. Scegli giochi preferiti e canali."
        ]
      ]
    }
  },
  "de": {
    "tagline": "WENIGER WARTEN. MEHR BELOHNUNGEN.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Drops farmen,\nohne Finger\nzu rühren.",
        "steps": [
          "Findet einen Stream",
          "Verfolgt Fortschritt",
          "Holt Belohnungen ab"
        ]
      },
      "games": {
        "number": "02",
        "title": "Deine Spiele.\nDeine Prioritäten.",
        "description": "Lurkloot farmt standardmäßig alle Spiele. Nur bestimmte? Auswählen, Favoriten markieren, den Rest blockieren."
      },
      "kick": {
        "number": "03",
        "title": "Viel mehr als\nnur Drops."
      },
      "watchlist": {
        "number": "04",
        "feature": "Ersatzliste",
        "title": "Weiter schauen,\nauch ohne Drops.",
        "howItWorks": [
          "Wähle deine Lieblings-Streamer",
          "Nichts zu farmen? Der erste Live-Kanal wird geschaut",
          "Wechselt, sobald sie live oder offline gehen"
        ],
        "earning": "Sammelt weiter",
        "earns": {
          "twitch": [
            "Kanalpunkte"
          ],
          "kick": [
            "Tagesbonus",
            "Level-XP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farme alles.\nSchau nichts.",
        "description": "Immer kostenlos und Open Source. Keine Werbung, keine Abos."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Abzeichen",
        "Ersatzliste"
      ],
      "twitch": [
        "Kanalpunkte",
        "Twitch-Erweiterungen"
      ],
      "kick": [
        "Tägliche Belohnung",
        "Kontolevel"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatische Belohnungen.",
        "Unterstützt ausgewählte Twitch-Erweiterungen."
      ],
      "steps": [
        [
          "Drops ganz automatisch",
          "Stream finden. Fortschritt verfolgen. Belohnungen abholen."
        ],
        [
          "Auch Twitch-Erweiterungen",
          "Optionale Unterstützung ausgewählter Erweiterungsbelohnungen."
        ],
        [
          "Deine Reihenfolge",
          "Kampagnen anpinnen. Spiele favorisieren. Kanäle wählen."
        ]
      ]
    }
  },
  "pt_BR": {
    "tagline": "MENOS ESPERA. MAIS RECOMPENSAS.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farme drops\nsem levantar\num dedo.",
        "steps": [
          "Encontra uma live",
          "Monitora o progresso",
          "Resgata recompensas"
        ]
      },
      "games": {
        "number": "02",
        "title": "Seus jogos.\nSuas prioridades.",
        "description": "Lurkloot farma todos os jogos por padrão. Quer só alguns? Marque, favorite e bloqueie o resto."
      },
      "kick": {
        "number": "03",
        "title": "Muito mais\ndo que drops."
      },
      "watchlist": {
        "number": "04",
        "feature": "Lista de reserva",
        "title": "Continue assistindo\nsem drops.",
        "howItWorks": [
          "Escolha seus streamers favoritos",
          "Nada para farmar? O primeiro canal ao vivo é assistido",
          "Troca quando entram ao vivo ou saem do ar"
        ],
        "earning": "Continua ganhando",
        "earns": {
          "twitch": [
            "Pontos do canal"
          ],
          "kick": [
            "Recompensa diária",
            "XP de nível"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farme tudo.\nNão assista nada.",
        "description": "Sempre grátis e de código aberto. Sem anúncios, sem assinaturas."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Emblemas",
        "Lista de reserva"
      ],
      "twitch": [
        "Pontos de canal",
        "Extensões da Twitch"
      ],
      "kick": [
        "Recompensa diária",
        "Nível na Kick"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Recompensas automáticas.",
        "Suporte a algumas extensões da Twitch."
      ],
      "steps": [
        [
          "Drops no automático",
          "Encontre uma transmissão. Acompanhe o progresso. Resgate recompensas."
        ],
        [
          "Extensões da Twitch também",
          "Suporte opcional a recompensas de algumas extensões."
        ],
        [
          "Sua ordem de exibição",
          "Fixe campanhas. Favorite jogos. Escolha seus canais."
        ]
      ]
    }
  },
  "tr": {
    "tagline": "DAHA AZ BEKLE. DAHA ÇOK ÖDÜL.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Drop farm'la\nparmak\nkıpırdatmadan.",
        "steps": [
          "Canlı yayın bulur",
          "İlerlemeyi takip eder",
          "Ödülleri toplar"
        ]
      },
      "games": {
        "number": "02",
        "title": "Oyunların.\nÖnceliklerin.",
        "description": "Lurkloot tüm oyunları varsayılan farmlar. Sadece bazıları mı? İşaretle, favorile, kalanı engelle."
      },
      "kick": {
        "number": "03",
        "title": "Drop'tan çok\ndaha fazlası."
      },
      "watchlist": {
        "number": "04",
        "feature": "Yedek izleme listesi",
        "title": "Drop olmadığında\nizlemeye devam et.",
        "howItWorks": [
          "Favori yayıncılarını seç",
          "Farm edilecek bir şey yok mu? İlk canlı kanal izlenir",
          "Yayına geçtiklerinde veya çevrimdışı olduklarında değişir"
        ],
        "earning": "Kazanmaya devam eder",
        "earns": {
          "twitch": [
            "Kanal puanları"
          ],
          "kick": [
            "Günlük ödül",
            "Seviye XP'si"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Her şeyi farm'la.\nHiçbir şey izleme.",
        "description": "Her zaman ücretsiz ve açık kaynak. Reklam yok, abonelik yok."
      }
    },
    "platforms": {
      "both": [
        "Drop'lar",
        "Rozetler",
        "Yedek izleme listesi"
      ],
      "twitch": [
        "Kanal puanları",
        "Twitch uzantıları"
      ],
      "kick": [
        "Günlük ödül",
        "Hesap seviyesi"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Otomatik ödüller.",
        "Seçili Twitch uzantılarını destekler."
      ],
      "steps": [
        [
          "Drop’lar otomatik pilotta",
          "Bir yayın bul. İlerlemeyi takip et. Ödülleri al."
        ],
        [
          "Twitch uzantıları da var",
          "Seçili uzantı ödülleri için isteğe bağlı destek."
        ],
        [
          "İzleme sıran",
          "Kampanyaları sabitle. Oyunları favorile. Kanallarını seç."
        ]
      ]
    }
  },
  "ru": {
    "tagline": "МЕНЬШЕ ОЖИДАНИЯ. БОЛЬШЕ НАГРАД.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Фармите дропы\nне шевеля\nпальцем.",
        "steps": [
          "Находит стрим",
          "Отслеживает прогресс",
          "Получает награды"
        ]
      },
      "games": {
        "number": "02",
        "title": "Ваши игры.\nВаши приоритеты.",
        "description": "Lurkloot по умолчанию фармит все игры. Нужны не все? Отметьте, добавьте в избранное, заблокируйте остальные."
      },
      "kick": {
        "number": "03",
        "title": "Гораздо больше,\nчем дропы."
      },
      "watchlist": {
        "number": "04",
        "feature": "Резервный список",
        "title": "Продолжайте смотреть,\nкогда дропов нет.",
        "howItWorks": [
          "Выберите любимых стримеров",
          "Нечего фармить? Смотрится первый канал в эфире",
          "Переключается, когда они выходят в эфир или уходят"
        ],
        "earning": "Продолжает зарабатывать",
        "earns": {
          "twitch": [
            "Баллы канала"
          ],
          "kick": [
            "Ежедневный бонус",
            "XP за уровень"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Фарми всё.\nНичего не смотри.",
        "description": "Всегда бесплатно и с открытым кодом. Без рекламы и подписок."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Значки",
        "Резервный список"
      ],
      "twitch": [
        "Баллы канала",
        "Расширения Twitch"
      ],
      "kick": [
        "Ежедневная награда",
        "Уровень аккаунта"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Награды автоматически.",
        "Поддержка некоторых расширений Twitch."
      ],
      "steps": [
        [
          "Дропы на автопилоте",
          "Найдите трансляцию. Следите за прогрессом. Забирайте награды."
        ],
        [
          "И расширения Twitch",
          "Поддержка наград некоторых расширений по желанию."
        ],
        [
          "Ваш порядок просмотра",
          "Закрепляйте кампании. Выбирайте игры и каналы."
        ]
      ]
    }
  },
  "zh_CN": {
    "tagline": "少些等待，多些奖励。",
    "stories": {
      "queue": {
        "number": "01",
        "title": "无需动手\n挂机掉宝",
        "steps": [
          "自动寻找直播",
          "追踪观看进度",
          "自动领取奖励"
        ]
      },
      "games": {
        "number": "02",
        "title": "你的游戏。\n你的优先级。",
        "description": "Lurkloot 默认挂机所有游戏。只挂部分？勾选、收藏，其余屏蔽即可。"
      },
      "kick": {
        "number": "03",
        "title": "远不止\n掉宝。"
      },
      "watchlist": {
        "number": "04",
        "feature": "空闲观看列表",
        "title": "没有掉宝时\n也要继续观看。",
        "howItWorks": [
          "选择你喜欢的主播",
          "没有可刷的内容？观看第一个正在直播的频道",
          "主播开播或下播时自动切换"
        ],
        "earning": "持续获得",
        "earns": {
          "twitch": [
            "频道点数"
          ],
          "kick": [
            "每日奖励",
            "等级 XP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "全部挂机。\n什么都不看。",
        "description": "永久免费开源。无广告，无订阅。"
      }
    },
    "platforms": {
      "both": [
        "掉宝",
        "徽章",
        "空闲观看列表"
      ],
      "twitch": [
        "频道积分",
        "Twitch 扩展"
      ],
      "kick": [
        "每日奖励",
        "账户等级"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick。自动获取奖励。",
        "支持部分 Twitch 扩展。"
      ],
      "steps": [
        [
          "掉宝自动搞定",
          "寻找直播，跟踪进度，领取奖励。"
        ],
        [
          "也支持 Twitch 扩展",
          "按需启用部分扩展奖励的支持。"
        ],
        [
          "你的观看顺序",
          "置顶活动，收藏游戏，选择频道。"
        ]
      ]
    }
  },
  "hi": {
    "tagline": "कम इंतज़ार। ज़्यादा इनाम।",
    "stories": {
      "queue": {
        "number": "01",
        "title": "ड्रॉप्स फ़ार्म करें\nबिना उंगली\nहिलाए।",
        "steps": [
          "स्ट्रीम ढूंढता है",
          "प्रगति ट्रैक करता है",
          "इनाम लेता है"
        ]
      },
      "games": {
        "number": "02",
        "title": "आपके गेम।\nआपकी प्राथमिकताएँ।",
        "description": "Lurkloot डिफ़ॉल्ट रूप से हर गेम फ़ार्म करता है। सिर्फ़ कुछ चाहिए? चुनें, पसंदीदा स्टार करें, बाकी ब्लॉक करें।"
      },
      "kick": {
        "number": "03",
        "title": "ड्रॉप्स से\nकहीं ज़्यादा।"
      },
      "watchlist": {
        "number": "04",
        "feature": "आइडल वॉचलिस्ट",
        "title": "ड्रॉप्स न हों तब भी\nदेखते रहें।",
        "howItWorks": [
          "अपने पसंदीदा स्ट्रीमर चुनें",
          "फ़ार्म करने को कुछ नहीं? पहला लाइव चैनल देखा जाता है",
          "लाइव होने या बंद होने पर बदल जाता है"
        ],
        "earning": "कमाई जारी रहती है",
        "earns": {
          "twitch": [
            "चैनल पॉइंट"
          ],
          "kick": [
            "दैनिक इनाम",
            "लेवल XP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "सब फ़ार्म करें।\nकुछ न देखें।",
        "description": "हमेशा मुफ़्त और ओपन सोर्स। कोई विज्ञापन या सदस्यता नहीं।"
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "बैज",
        "आइडल वॉचलिस्ट"
      ],
      "twitch": [
        "चैनल पॉइंट्स",
        "Twitch एक्सटेंशन"
      ],
      "kick": [
        "दैनिक इनाम",
        "अकाउंट लेवल"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick। अपने-आप इनाम।",
        "चुनिंदा Twitch एक्सटेंशन का सपोर्ट।"
      ],
      "steps": [
        [
          "ड्रॉप्स अपने-आप",
          "स्ट्रीम ढूँढें। प्रगति देखें। इनाम क्लेम करें।"
        ],
        [
          "Twitch एक्सटेंशन भी",
          "चुनिंदा एक्सटेंशन के इनामों के लिए वैकल्पिक सपोर्ट।"
        ],
        [
          "आपका देखने का क्रम",
          "कैंपेन पिन करें। पसंदीदा गेम और चैनल चुनें।"
        ]
      ]
    }
  },
  "ar": {
    "tagline": "انتظار أقل. مكافآت أكثر.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "فارِم الدروب\nدون رفع إصبع.",
        "steps": [
          "يجد بثًا مباشرًا",
          "يتابع تقدمك",
          "يستلم المكافآت"
        ]
      },
      "games": {
        "number": "02",
        "title": "ألعابك.\nأولوياتك.",
        "description": "يفارم Lurkloot كل الألعاب افتراضيًا. تريد بعضها فقط؟ حدّدها، ثبّت المفضلة، واحظر الباقي."
      },
      "kick": {
        "number": "03",
        "title": "أكثر بكثير\nمن الدروب."
      },
      "watchlist": {
        "number": "04",
        "feature": "قائمة الانتظار للمشاهدة",
        "title": "استمر في المشاهدة\nحين لا توجد دروبس.",
        "howItWorks": [
          "اختر قنواتك المفضلة",
          "لا شيء لتجميعه؟ تُشاهَد أول قناة تبث مباشرة",
          "يتبدّل عند بدء البث أو توقفه"
        ],
        "earning": "يواصل الكسب",
        "earns": {
          "twitch": [
            "نقاط القناة"
          ],
          "kick": [
            "المكافأة اليومية",
            "مستوى XP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "فارِم كل شيء.\nلا تشاهد شيئًا.",
        "description": "مجاني دائمًا ومفتوح المصدر. بلا إعلانات ولا اشتراكات."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "شارات",
        "قائمة الانتظار للمشاهدة"
      ],
      "twitch": [
        "نقاط القناة",
        "إضافات Twitch"
      ],
      "kick": [
        "المكافأة اليومية",
        "مستوى الحساب"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. مكافآت تلقائية.",
        "يدعم إضافات مختارة على Twitch."
      ],
      "steps": [
        [
          "دروب تلقائية",
          "اعثر على بث. تابع التقدم. طالب بالمكافآت."
        ],
        [
          "وإضافات Twitch أيضًا",
          "دعم اختياري لمكافآت إضافات مختارة."
        ],
        [
          "ترتيب المشاهدة الخاص بك",
          "ثبّت الحملات. اختر ألعابك المفضلة وقنواتك."
        ]
      ]
    }
  },
  "ja": {
    "tagline": "視聴は減らして、報酬は増やす。",
    "stories": {
      "queue": {
        "number": "01",
        "title": "ドロップを\n手間いらずで\nファーム",
        "steps": [
          "配信を見つける",
          "進捗を追跡",
          "報酬を受け取る"
        ]
      },
      "games": {
        "number": "02",
        "title": "あなたのゲーム。\nあなたの優先度。",
        "description": "Lurkloot は既定で全ゲームをファーム。一部だけなら選択し、お気に入りに星、残りはブロック。"
      },
      "kick": {
        "number": "03",
        "title": "ドロップだけ\nじゃない。"
      },
      "watchlist": {
        "number": "04",
        "feature": "アイドル・ウォッチリスト",
        "title": "ドロップが無くても、\n視聴は続く。",
        "howItWorks": [
          "お気に入りの配信者を選ぶ",
          "ファーミングするものがない？ 最初のライブチャンネルを視聴",
          "配信開始・終了に合わせて自動で切り替え"
        ],
        "earning": "獲得を継続",
        "earns": {
          "twitch": [
            "チャンネルポイント"
          ],
          "kick": [
            "デイリー報酬",
            "レベルXP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "全部ファーム。\n何も見ない。",
        "description": "いつでも無料のオープンソース。広告もサブスクもなし。"
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "バッジ",
        "アイドル・ウォッチリスト"
      ],
      "twitch": [
        "チャンネルポイント",
        "Twitch 拡張機能"
      ],
      "kick": [
        "デイリー報酬",
        "アカウントレベル"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick。報酬は自動。",
        "選ばれた Twitch 拡張機能に対応。"
      ],
      "steps": [
        [
          "ドロップはオートパイロット",
          "配信を見つける。進捗を追う。報酬を受け取る。"
        ],
        [
          "Twitch 拡張機能も",
          "選ばれた拡張機能報酬のオプションサポート。"
        ],
        [
          "あなたの視聴順序",
          "キャンペーンをピン留め。ゲームにスター。チャンネルを選ぶ。"
        ]
      ]
    }
  },
  "id": {
    "tagline": "LEBIH SEDIKIT NONTON. LEBIH BANYAK HADIAH.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farm drop\ntanpa angkat\njari.",
        "steps": [
          "Mencari siaran live",
          "Melacak progres",
          "Mengklaim hadiah"
        ]
      },
      "games": {
        "number": "02",
        "title": "Game Anda.\nPrioritas Anda.",
        "description": "Lurkloot secara default farming semua game. Hanya sebagian? Centang, beri bintang favorit, blokir sisanya."
      },
      "kick": {
        "number": "03",
        "title": "Lebih dari\nsekadar drop."
      },
      "watchlist": {
        "number": "04",
        "feature": "Idle Watchlist",
        "title": "Tetap menonton\nsaat tak ada drop.",
        "howItWorks": [
          "Pilih streamer favoritmu",
          "Tak ada yang di-farm? Saluran live pertama yang ditonton",
          "Beralih saat mereka mulai atau berhenti siaran"
        ],
        "earning": "Tetap mendapatkan",
        "earns": {
          "twitch": [
            "Poin channel"
          ],
          "kick": [
            "Reward harian",
            "XP level"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farm semua.\nTanpa menonton.",
        "description": "Selalu gratis dan open source. Tanpa iklan, tanpa langganan."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Lencana",
        "Idle Watchlist"
      ],
      "twitch": [
        "Poin channel",
        "Ekstensi Twitch"
      ],
      "kick": [
        "Hadiah harian",
        "Level akun"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Hadiah otomatis.",
        "Mendukung ekstensi Twitch pilihan."
      ],
      "steps": [
        [
          "Drop jalan otomatis",
          "Cari siaran. Lacak progres. Klaim hadiah."
        ],
        [
          "Ekstensi Twitch juga",
          "Dukungan opsional untuk hadiah ekstensi pilihan."
        ],
        [
          "Urutan tonton Anda",
          "Sematkan kampanye. Bintangi game. Pilih saluran."
        ]
      ]
    }
  },
  "pl": {
    "tagline": "MNIEJ OGLĄDANIA. WIĘCEJ NAGROD.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farmuj dropy\nbez kiwnięcia\npalcem.",
        "steps": [
          "Znajduje transmisje",
          "Śledzi postępy",
          "Odbiera nagrody"
        ]
      },
      "games": {
        "number": "02",
        "title": "Twoje gry.\nTwoje priorytety.",
        "description": "Lurkloot farmi domyślnie wszystkie gry. Tylko wybrane? Zaznacz je, oznacz ulubione, zablokuj resztę."
      },
      "kick": {
        "number": "03",
        "title": "Dużo więcej\nniż dropy."
      },
      "watchlist": {
        "number": "04",
        "feature": "Lista zapasowa",
        "title": "Oglądaj dalej,\ngdy nie ma dropów.",
        "howItWorks": [
          "Wybierz ulubionych streamerów",
          "Nic do farmienia? Oglądany jest pierwszy kanał na żywo",
          "Przełącza się, gdy wchodzą na żywo lub znikają"
        ],
        "earning": "Nadal zdobywa",
        "earns": {
          "twitch": [
            "Punkty kanału"
          ],
          "kick": [
            "Codzienna nagroda",
            "XP poziomu"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farmuj wszystko.\nNie oglądaj nic.",
        "description": "Zawsze za darmo i open source. Bez reklam i subskrypcji."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Odznaki",
        "Lista zapasowa"
      ],
      "twitch": [
        "Punkty kanału",
        "Rozszerzenia Twitch"
      ],
      "kick": [
        "Dzienna nagroda",
        "Poziom konta"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatyczne nagrody.",
        "Obsługa wybranych rozszerzeń Twitch."
      ],
      "steps": [
        [
          "Dropy na autopilocie",
          "Znajdź stream. Śledź postęp. Odbieraj nagrody."
        ],
        [
          "Też rozszerzenia Twitch",
          "Opcjonalne wsparcie dla wybranych nagród z rozszerzeń."
        ],
        [
          "Twoja kolejność",
          "Przypinaj kampanie. Oznaczaj gry. Wybieraj kanały."
        ]
      ]
    }
  },
  "ko": {
    "tagline": "시청은 줄이고, 보상은 늘리세요.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "손 까딱 없이\n드롭 파밍",
        "steps": [
          "라이브 방송 찾음",
          "진행 상황 추적",
          "보상 자동 수령"
        ]
      },
      "games": {
        "number": "02",
        "title": "내 게임.\n내 우선순위.",
        "description": "Lurkloot은 기본으로 모든 게임을 파밍합니다. 일부만? 선택·즐겨찾기하고 나머지는 차단하세요."
      },
      "kick": {
        "number": "03",
        "title": "드롭보다\n훨씬 많은 것."
      },
      "watchlist": {
        "number": "04",
        "feature": "대기 시청 목록",
        "title": "드롭이 없어도\n계속 시청하세요.",
        "howItWorks": [
          "좋아하는 스트리머를 고르세요",
          "파밍할 게 없나요? 첫 라이브 채널을 시청",
          "라이브 시작·종료에 따라 자동으로 전환"
        ],
        "earning": "계속 획득",
        "earns": {
          "twitch": [
            "채널 포인트"
          ],
          "kick": [
            "일일 보상",
            "레벨 XP"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "모두 파밍.\n아무것도 안 봐.",
        "description": "언제나 무료이며 오픈 소스. 광고도 구독도 없습니다."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "배지",
        "대기 시청 목록"
      ],
      "twitch": [
        "채널 포인트",
        "Twitch 확장"
      ],
      "kick": [
        "일일 보상",
        "계정 레벨"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. 자동 보상.",
        "선택한 Twitch 확장 지원."
      ],
      "steps": [
        [
          "드롭 자동화",
          "스트림을 찾고, 진행을 추적하고, 보상을 수령하세요."
        ],
        [
          "Twitch 확장도",
          "선택한 확장 보상에 대한 선택적 지원."
        ],
        [
          "내 시청 순서",
          "캠페인 고정. 게임에 별표. 채널 선택."
        ]
      ]
    }
  },
  "uk": {
    "tagline": "МЕНШЕ ПЕРЕГЛЯДУ. БІЛЬШЕ НАГОРОД.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Фарміть дропи\nне ворухнувши\nпальцем.",
        "steps": [
          "Знаходить стрім",
          "Відстежує прогрес",
          "Отримує нагороди"
        ]
      },
      "games": {
        "number": "02",
        "title": "Ваші ігри.\nВаші пріоритети.",
        "description": "Lurkloot за замовчуванням фармить усі ігри. Лише деякі? Позначте їх, додайте улюблені, решту заблокуйте."
      },
      "kick": {
        "number": "03",
        "title": "Значно більше,\nніж дропи."
      },
      "watchlist": {
        "number": "04",
        "feature": "Idle Watchlist",
        "title": "Дивіться далі,\nколи дропів немає.",
        "howItWorks": [
          "Оберіть улюблених стримерів",
          "Нема чого фармити? Дивиться перший канал у ефірі",
          "Перемикається, коли вони виходять в ефір або йдуть офлайн"
        ],
        "earning": "Продовжує заробляти",
        "earns": {
          "twitch": [
            "Бали каналу"
          ],
          "kick": [
            "Щоденна нагорода",
            "XP за рівень"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Фарми все.\nНічого не дивись.",
        "description": "Завжди безкоштовно і з відкритим кодом. Без реклами й підписок."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Значки",
        "Idle Watchlist"
      ],
      "twitch": [
        "Бали каналу",
        "Розширення Twitch"
      ],
      "kick": [
        "Щоденна нагорода",
        "Рівень акаунта"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Автоматичні нагороди.",
        "Підтримка обраних розширень Twitch."
      ],
      "steps": [
        [
          "Дропи на автопілоті",
          "Знайти стрим. Відстежити прогрес. Забрати нагороди."
        ],
        [
          "Також розширення Twitch",
          "Необов’язкова підтримка нагород обраних розширень."
        ],
        [
          "Ваш порядок перегляду",
          "Закріплюйте кампанії. Позначайте ігри. Обирайте канали."
        ]
      ]
    }
  },
  "cs": {
    "tagline": "MÉNĚ SLEDOVÁNÍ. VÍCE ODMĚN.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Farmi dropy\nbez hnutí\nprstem.",
        "steps": [
          "Najde živé vysílání",
          "Sleduje postup",
          "Vyzvedne odměny"
        ]
      },
      "games": {
        "number": "02",
        "title": "Vaše hry.\nVaše priority.",
        "description": "Lurkloot ve výchozím stavu farmí všechny hry. Jen některé? Zaškrtni je, označ oblíbené a zbytek zablokuj."
      },
      "kick": {
        "number": "03",
        "title": "Mnohem víc\nnež drops."
      },
      "watchlist": {
        "number": "04",
        "feature": "Záložní seznam",
        "title": "Sleduj dál,\nkdyž nejsou drops.",
        "howItWorks": [
          "Vyber si oblíbené streamery",
          "Nic k farmení? Sleduje se první live kanál",
          "Přepíná se, když začnou nebo přestanou vysílat"
        ],
        "earning": "Stále vydělává",
        "earns": {
          "twitch": [
            "Body kanálu"
          ],
          "kick": [
            "Denní odměna",
            "XP úrovně"
          ]
        }
      },
      "free": {
        "number": "05",
        "title": "Farmi vše.\nNic nesleduj.",
        "description": "Vždy zdarma a open source. Žádné reklamy, žádná předplatná."
      }
    },
    "platforms": {
      "both": [
        "Drops",
        "Odznaky",
        "Záložní seznam"
      ],
      "twitch": [
        "Body kanálu",
        "Rozšíření Twitch"
      ],
      "kick": [
        "Denní odměna",
        "Úroveň účtu"
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatické odměny.",
        "Podporuje vybraná Twitch rozšíření."
      ],
      "steps": [
        [
          "Drops na autopilotu",
          "Najde stream. Sleduje postup. Vyzvedne odměny."
        ],
        [
          "I Twitch rozšíření",
          "Volitelná podpora odměn z vybraných rozšíření."
        ],
        [
          "Vaše pořadí sledování",
          "Připněte kampaně. Označte hry. Vyberte kanály."
        ]
      ]
    }
  }
};
