import type { SupportedLocale } from "@lurkloot/shared/models";

// Store artwork copy is kept separate from product UI messages.
export interface StoreArtworkCopy {
  tagline: string;
  stories: {
    // The opening shot: what Lurkloot does for you, beside the full popup.
    queue: StoreArtworkStory & { steps: string[] };
    games: StoreArtworkStory & { description: string };
    kick: StoreArtworkStory;
    // What idle watching still earns, shown as tags under the subtitle.
    watchlist: StoreArtworkStory & { description: string; earns: { twitch: string[]; kick: string[] } };
    free: StoreArtworkStory & { description: string };
  };
  // What Lurkloot supports on each platform, listed in the dual-platform shot.
  platforms: { twitch: string[]; kick: string[] };
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
        "title": "Two platforms.\nOne workspace."
      },
      "watchlist": {
        "number": "04",
        "title": "Keep watching\nwhen there are no drops.",
        "description": "Lurkloot lurks in your favourite channels and keeps earning:",
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
      "twitch": [
        "Drops",
        "Badges",
        "Idle watchlist",
        "Channel points",
        "Twitch extensions"
      ],
      "kick": [
        "Drops",
        "Badges",
        "Idle watchlist",
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
        "title": "Dos plataformas.\nUn solo lugar."
      },
      "watchlist": {
        "number": "04",
        "title": "Sigue viendo\ncuando no haya drops.",
        "description": "Lurkloot vigila tus canales favoritos y sigue ganando:",
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
      "twitch": [
        "Drops",
        "Insignias",
        "Lista de reserva",
        "Puntos de canal",
        "Extensiones de Twitch"
      ],
      "kick": [
        "Drops",
        "Insignias",
        "Lista de reserva",
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
        "title": "Deux plateformes.\nUn seul espace."
      },
      "watchlist": {
        "number": "04",
        "title": "Continuez à regarder\nsans drops.",
        "description": "Lurkloot suit vos chaînes favorites et continue de gagner :",
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
      "twitch": [
        "Drops",
        "Badges",
        "Liste de veille",
        "Points de chaîne",
        "Extensions Twitch"
      ],
      "kick": [
        "Drops",
        "Badges",
        "Liste de veille",
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
        "title": "Due piattaforme.\nUn unico spazio."
      },
      "watchlist": {
        "number": "04",
        "title": "Continua a guardare\nsenza drop.",
        "description": "Lurkloot segue i tuoi canali preferiti e continua a guadagnare:",
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
      "twitch": [
        "Drops",
        "Badge",
        "Lista di riserva",
        "Punti canale",
        "Estensioni Twitch"
      ],
      "kick": [
        "Drops",
        "Badge",
        "Lista di riserva",
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
        "title": "Zwei Plattformen.\nEin Ort."
      },
      "watchlist": {
        "number": "04",
        "title": "Weiter schauen,\nauch ohne Drops.",
        "description": "Lurkloot schaut in deinen Lieblingskanälen vorbei und sammelt weiter:",
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
      "twitch": [
        "Drops",
        "Abzeichen",
        "Leerlauf-Watchlist",
        "Kanalpunkte",
        "Twitch-Erweiterungen"
      ],
      "kick": [
        "Drops",
        "Abzeichen",
        "Leerlauf-Watchlist",
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
        "title": "Duas plataformas.\nUm só lugar."
      },
      "watchlist": {
        "number": "04",
        "title": "Continue assistindo\nsem drops.",
        "description": "Lurkloot fica nos seus canais favoritos e continua ganhando:",
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
      "twitch": [
        "Drops",
        "Emblemas",
        "Lista de reserva",
        "Pontos de canal",
        "Extensões da Twitch"
      ],
      "kick": [
        "Drops",
        "Emblemas",
        "Lista de reserva",
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
        "title": "İki platform.\nTek alan."
      },
      "watchlist": {
        "number": "04",
        "title": "Drop olmadığında\nizlemeye devam et.",
        "description": "Lurkloot favori kanallarında bekler ve kazanmaya devam eder:",
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
      "twitch": [
        "Drop'lar",
        "Rozetler",
        "Yedek Kanallar",
        "Kanal puanları",
        "Twitch uzantıları"
      ],
      "kick": [
        "Drop'lar",
        "Rozetler",
        "Yedek Kanallar",
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
        "title": "Две платформы.\nОдно место."
      },
      "watchlist": {
        "number": "04",
        "title": "Продолжайте смотреть,\nкогда дропов нет.",
        "description": "Lurkloot сидит в любимых каналах и продолжает зарабатывать:",
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
      "twitch": [
        "Drops",
        "Значки",
        "Список просмотра",
        "Баллы канала",
        "Расширения Twitch"
      ],
      "kick": [
        "Drops",
        "Значки",
        "Список просмотра",
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
        "title": "两个平台。\n一个工作区。"
      },
      "watchlist": {
        "number": "04",
        "title": "没有掉宝时\n也要继续观看。",
        "description": "Lurkloot 在你收藏的频道里待命，持续获得：",
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
      "twitch": [
        "掉宝",
        "徽章",
        "空闲观看列表",
        "频道积分",
        "Twitch 扩展"
      ],
      "kick": [
        "掉宝",
        "徽章",
        "空闲观看列表",
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
        "title": "दो प्लेटफ़ॉर्म।\nएक जगह।"
      },
      "watchlist": {
        "number": "04",
        "title": "ड्रॉप्स न हों तब भी\nदेखते रहें।",
        "description": "Lurkloot पसंदीदा चैनल पर रहता है और कमाई जारी रखता है:",
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
      "twitch": [
        "Drops",
        "बैज",
        "निष्क्रिय वॉचलिस्ट",
        "चैनल पॉइंट्स",
        "Twitch एक्सटेंशन"
      ],
      "kick": [
        "Drops",
        "बैज",
        "निष्क्रिय वॉचलिस्ट",
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
        "title": "منصتان.\nمساحة واحدة."
      },
      "watchlist": {
        "number": "04",
        "title": "استمر في المشاهدة\nحين لا توجد دروبس.",
        "description": "يتابع Lurkloot قنواتك المفضلة ويواصل الربح:",
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
      "twitch": [
        "Drops",
        "شارات",
        "المشاهدة الخاملة",
        "نقاط القناة",
        "إضافات Twitch"
      ],
      "kick": [
        "Drops",
        "شارات",
        "المشاهدة الخاملة",
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
        "title": "2つのプラットフォーム。\n1つのワークスペース。"
      },
      "watchlist": {
        "number": "04",
        "title": "ドロップが無くても、\n視聴は続く。",
        "description": "Lurkloot はお気に入りチャンネルで待機し、稼ぎ続けます:",
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
      "twitch": [
        "Drops",
        "バッジ",
        "アイドル・ウォッチリスト",
        "チャンネルポイント",
        "Twitch 拡張機能"
      ],
      "kick": [
        "Drops",
        "バッジ",
        "アイドル・ウォッチリスト",
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
        "title": "Dua platform.\nSatu tempat."
      },
      "watchlist": {
        "number": "04",
        "title": "Tetap menonton\nsaat tak ada drop.",
        "description": "Lurkloot memantau channel favoritmu dan terus dapat reward:",
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
      "twitch": [
        "Drops",
        "Lencana",
        "Idle Watchlist",
        "Poin channel",
        "Ekstensi Twitch"
      ],
      "kick": [
        "Drops",
        "Lencana",
        "Idle Watchlist",
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
        "title": "Dwie platformy.\nJedno miejsce."
      },
      "watchlist": {
        "number": "04",
        "title": "Oglądaj dalej,\ngdy nie ma dropów.",
        "description": "Lurkloot ogląda ulubione kanały i dalej zbiera nagrody:",
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
      "twitch": [
        "Drops",
        "Odznaki",
        "Lista zapasowa",
        "Punkty kanału",
        "Rozszerzenia Twitch"
      ],
      "kick": [
        "Drops",
        "Odznaki",
        "Lista zapasowa",
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
        "title": "두 플랫폼.\n하나의 작업 공간."
      },
      "watchlist": {
        "number": "04",
        "title": "드롭이 없어도\n계속 시청하세요.",
        "description": "Lurkloot이 즐겨찾는 채널에서 대기하며 계속 얻습니다:",
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
      "twitch": [
        "Drops",
        "배지",
        "대기 시청 목록",
        "채널 포인트",
        "Twitch 확장"
      ],
      "kick": [
        "Drops",
        "배지",
        "대기 시청 목록",
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
        "title": "Дві платформи.\nОдин робочий простір."
      },
      "watchlist": {
        "number": "04",
        "title": "Дивіться далі,\nколи дропів немає.",
        "description": "Lurkloot сидить у ваших улюблених каналах і далі заробляє:",
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
      "twitch": [
        "Drops",
        "Значки",
        "Idle Watchlist",
        "Бали каналу",
        "Розширення Twitch"
      ],
      "kick": [
        "Drops",
        "Значки",
        "Idle Watchlist",
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
        "title": "Dvě platformy.\nJeden pracovní prostor."
      },
      "watchlist": {
        "number": "04",
        "title": "Sledujte dál,\nkdyž nejsou drops.",
        "description": "Lurkloot sleduje tvoje oblíbené kanály a dál získává:",
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
      "twitch": [
        "Drops",
        "Odznaky",
        "Záložní seznam",
        "Channel points",
        "Rozšíření Twitch"
      ],
      "kick": [
        "Drops",
        "Odznaky",
        "Záložní seznam",
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
