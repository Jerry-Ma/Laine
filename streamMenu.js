const Gio = imports.gi.Gio;
const Lang = imports.lang;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const PopupMenu = imports.ui.popupMenu;
const Shell = imports.gi.Shell;
const Main = imports.ui.main;
const Slider = imports.ui.slider;
const Loop = imports.mainloop;


const WindowTracker = Shell.WindowTracker.get_default();
const Me = imports.misc.extensionUtils.getCurrentExtension();


const PA_MAX = 65536;
const WATCH_RULE = "type='signal'," +
		"sender='org.freedesktop.DBus'," +
		"interface='org.freedesktop.DBus'," +
		"member='NameOwnerChanged'," +
		"path='/org/freedesktop/DBus'," +
		"arg0namespace='org.mpris.MediaPlayer2'";

const StreamMenu = new Lang.Class({
	Name: 'StreamMenu',
	Extends: PopupMenu.PopupMenuSection,

	_init: function(paconn){
		this.parent();
		this._paDBus = paconn;

		this._mprisControl = new MPRISControl(this, this._paDBus);

		this._streams = {};
		this._delegatedStreams = {};
		this._streams.length = 0;

		//Add any existing streams
		if(!(this._mprisControl))
			this._addExistingStreams();
		/*
		this._paDBus.call(null, '/org/pulseaudio/core1', 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1', 'PlaybackStreams']), 
			GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, this._hdlAddStreams));
		*/
		//Add signal handlers
		this._sigNewStr = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1', 'NewPlaybackStream',
			'/org/pulseaudio/core1', null, Gio.DBusSignalFlags.NONE, Lang.bind(this, this._onAddStream), null );
		this._sigRemStr = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1', 'PlaybackStreamRemoved',
			'/org/pulseaudio/core1', null, Gio.DBusSignalFlags.NONE, Lang.bind(this, this._onRemoveStream), null );

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
	},

	_addExistingStreams: function(){
		this._paDBus.call(null, '/org/pulseaudio/core1', 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1', 'PlaybackStreams']), 
			GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, -1, null, 
			Lang.bind(this, function(conn, query){
				let response = conn.call_finish(query).get_child_value(0).unpack();
				for(let i = 0; i < response.n_children(); i++)
					this._addPAStream(response.get_child_value(i).get_string()[0]);
			})
		);
	},

	_hdlAddStreams: function(conn, query){
		let response = conn.call_finish(query).get_child_value(0).unpack();
		for(let i = 0; i < response.n_children(); i++)
			this._addPAStream(response.get_child_value(i).get_string()[0]);
	},

	_addPAStream: function(path){
		this._paDBus.call(null, path, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'PropertyList']), 
			GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let streamInfo = conn.call_finish(query).get_child_value(0).unpack();

				//Decode stream information
				let sInfo = {};
				for(let i = 0; i < streamInfo.n_children(); i++){
					let [key, value] = streamInfo.get_child_value(i).unpack();
					let bytes = new Array();
					for(let j = 0; j < value.n_children(); j++)
						bytes[j] = value.get_child_value(j).get_byte();
					sInfo[key.get_string()[0]] = String.fromCharCode.apply(String, bytes);
				}

				let pID = parseInt(sInfo['application.process.id']);
				let role;
				if('media.role' in sInfo){
					role = sInfo['media.role'];
					role = role.substring(0, role.length -1);
				}

				this._moveStreamToDefaultSink(path);

				if(role != 'event'){
					let mprisCheck = false;

					if(this._mprisControl){
						mprisCheck = this._mprisControl.isMPRISStream(pID, path);
					}

					if(mprisCheck){
						this._delegatedStreams[path] = this._mprisControl._mprisStreams[pID];
					} else {
						let stream = new SimpleStream(this._paDBus, path, sInfo);
						this._streams[path] = stream;
						this.addMenuItem(stream);
						this._streams.length ++;
					}
				}
			})
		);
	},

	_moveStreamToDefaultSink: function(path) {
		this._paDBus.call(null, path, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'Device']), GLib.VariantType.new('(v)'), 
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let resp = conn.call_finish(query);
				resp = resp.get_child_value(0).unpack();

				let cPath = resp.get_string()[0];
				if(cPath != path)
					this._paDBus.call(null, path, 'org.PulseAudio.Core1.Stream', 'Move',
						GLib.Variant.new('(o)', [this._defaultSink]), null, Gio.DBusCallFlags.NONE, -1, null, null);
			})
		);
	},

	_onSetDefaultSink: function(src, sink){
		this._defaultSink = sink;

		for(let k in this._streams)
			if(k != 'length')
				this._moveStreamToDefaultSink(k);
		
		for(let k in this._delegatedStreams){
			if(k != 'length'){
				let obj = this._delegatedStreams[k]._paPath;
				this._moveStreamToDefaultSink(obj);
			}

		}
	},

	_onAddStream: function(conn, sender, object, iface, signal, param, user_data){
		let streamPath = param.get_child_value(0).unpack();
		this._addPAStream(streamPath);
/*
		if(this._streams.length > 0)
			this.actor.show();*/
	},

	_onRemoveStream: function(conn, sender, object, iface, signal, param, user_data){
		
		let streamPath = param.get_child_value(0).unpack();
		
		if(streamPath in this._streams){
			this._streams[streamPath].destroy();
			delete this._streams[streamPath];
			this._streams.length --;
			this.actor.queue_relayout();
/*
			if(this._streams.length == 0)
				this.actor.hide();*/
		}
		else if(streamPath in this._delegatedStreams){
			this._mprisControl.removePAStream(streamPath);
			delete this._delegatedStreams[streamPath];
		}
	},

	_onDestroy: function(){
		this._paDBus.signal_unsubscribe(this._sigNewStr);
		this._paDBus.signal_unsubscribe(this._sigRemStr);
	}
});


const StreamBase = new Lang.Class({
	Name: 'StreamBase',
	Extends: PopupMenu.PopupMenuSection,
	Abstract: true,

	_init: function(paconn){
		this.parent();
		this._paDBus = paconn;
		this._paPath = null;

		this._label = new St.Label({style_class: 'simple-stream-label', reactive: true})
		this._muteBtn = new St.Button();
		this._volSlider = new Slider.Slider(0);

		//------------------------------------------------------------------
		//Laying out components
		let container = new St.BoxLayout({vertical:true});
		container.add(this._label);
		container.add(this._volSlider.actor,{expand:true});

		this._volCtrl = new St.BoxLayout();
		this._volCtrl.add(this._muteBtn);
		this._volCtrl.add(container, {expand:true});
		this._volCtrl.add_style_class_name('stream');

		this.actor.set_vertical(false);
		this.actor.set_track_hover(true);
		this.actor.set_reactive(true);

		this.actor.add(this._volCtrl, {expand:true});

		//------------------------------------------------------------------
		
		this._muteBtn.connect('clicked', Lang.bind(this, function(){
			this.setVolume(!this._muteVal);
		}));

		this._volSlider.connect('value-changed', Lang.bind(this, function(slider, value, property){
			this.setVolume(value);
		}));

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
	},

	setPAPath: function(path){
		this._paPath = path;

		this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'Mute']), GLib.VariantType.new("(v)"), 
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let result = conn.call_finish(query);
				this.setVolume(result.get_child_value(0).unpack());
			}));

		this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'Volume']), GLib.VariantType.new("(v)"), 
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let result = conn.call_finish(query);
				this.setVolume(result.get_child_value(0).unpack());
			}));

		this._sigVol = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1.Stream', 'VolumeUpdated',
			this._paPath, null, Gio.DBusSignalFlags.NONE, Lang.bind(this, function(conn, sender, object, iface, signal, param, user_data){
				this.setVolume(param.get_child_value(0));
			}), null );
		this._sigMute = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1.Stream', 'MuteUpdated',
			this._paPath, null, Gio.DBusSignalFlags.NONE, Lang.bind(this, function(conn, sender, object, iface, signal, param, user_data){
				this.setVolume(param.get_child_value(0));
			}), null );
	},

	setVolume: function(volume){
		if(typeof volume === 'boolean' && this._paPath != null){
			let val = GLib.Variant.new_boolean(volume);
			this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Set',
				GLib.Variant.new('(ssv)', ['org.PulseAudio.Core1.Stream', 'Mute', val]), null, 
				Gio.DBusCallFlags.NONE, -1, null, null);
		} 	
		else if(typeof volume === 'number' && this._paPath != null){
			if(volume > 1) volume = 1;
			let max = this._volVariant.get_child_value(0).get_uint32();
			for(let i = 1; i < this._volVariant.n_children(); i++){
				let val = this._volVariant.get_child_value(i).get_uint32();
				if(val > max) max = val;
			}

			let target = volume * PA_MAX;
			if(target != max){ //Otherwise no change
				let targets = new Array();
				for(let i = 0; i < this._volVariant.n_children(); i++){
					let newVal;
					if(max == 0)
						newVal = target;
					else { //To maintain any balance the user has set.
						let oldVal = this._volVariant.get_child_value(i).get_uint32();
						newVal = (oldVal/max)*target;
					}
					newVal = Math.round(newVal);
					targets[i] = GLib.Variant.new_uint32(newVal);
				}
				targets = GLib.Variant.new_array(null, targets);
				this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Set',
					GLib.Variant.new('(ssv)', ['org.PulseAudio.Core1.Stream', 'Volume', targets]), null, 
					Gio.DBusCallFlags.NONE, -1, null, null);
				if(this._muteVal)
					this.setVolume(false);
			}
		}
		else if(volume instanceof GLib.Variant){
			let type = volume.get_type_string();
			if(type == 'au'){
				this._volVariant = volume;
				if(!this._muteVal){
					let maxVal = volume.get_child_value(0).get_uint32();
					for(let i = 1; i < volume.n_children(); i++){
						let val = volume.get_child_value(i).get_uint32();
						if(val > maxVal) maxVal = val;
					}

					this._volSlider.setValue(maxVal/PA_MAX);
				}
			}
			else if(type == 'b'){
				this._muteVal = volume.get_boolean();
				if(this._muteVal)
					this._volSlider.setValue(0);
				else if(this._volVariant)
					this.setVolume(this._volVariant);
			}
		}
	},

	_onDestroy: function(){
		if(this._paPath != null){
			this._paDBus.signal_unsubscribe(this._sigVol);
			this._paDBus.signal_unsubscribe(this._sigMute);
		}
	},

	_raise: function(){}

});

const SimpleStream = new Lang.Class({
	Name: 'SimpleStream',
	Extends: StreamBase,

	_init: function(paconn, path, sInfo){
		this.parent(paconn);
		this.setPAPath(path);

		this._procID = parseInt(sInfo['application.process.id']);

		this._app = WindowTracker.get_app_from_pid(this._procID);
		if(this._app == null){
			//Doesn't have an open window, lets check the tray.
			let trayNotifications = Main.messageTray.getSources();
			for(let i = 0; i < trayNotifications.length; i++)
				if(trayNotifications[i].pid == this._procID)
					this._app = trayNotifications[i].app;
		}

		let icon, name= null;
		if(this._app != null){
			let info = this._app.get_app_info();
			if(info != null){
				name = info.get_name();
				icon = new St.Icon({style_class: 'simple-stream-icon'});
				icon.set_gicon(info.get_icon());
			}
		}

		if(name == null){
			name = sInfo['application.name'];
			let iname;
			if('application.icon_name' in sInfo) iname = sInfo['application.icon_name'];
			else iname = 'package_multimedia';
			icon = new St.Icon({icon_name: iname, style_class: 'simple-stream-icon'});
		} 

		this._muteBtn.child = icon;
		this._label.text = name;

		this._label.connect('button-press-event', Lang.bind(this, function(){
			if(this._app != null)
				this._app.activate();
		}));
	}
});

const MPRISControl = new Lang.Class({
	Name: 'MPRISControl',

	_init: function(parent, paconn){
		this._parent = parent;
		this._paDBus = paconn
		this.actor = parent.actor;

		this._mprisStreams = {};
		this._mprisStreams.length = 0;

		Gio.bus_get(Gio.BusType.SESSION, null, Lang.bind(this, this._hdlBusConnection));

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
	},

	_hdlBusConnection: function(conn, query){
		this._dbus = Gio.bus_get_finish(query);
		this._dbus.call('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "ListNames",
			null, GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, this._hdlListNames));

		this._dbus.call('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "AddMatch",
			GLib.Variant.new('(s)', [WATCH_RULE]), null, Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(){
				this._sigNOC = this._dbus.signal_subscribe('org.freedesktop.DBus', "org.freedesktop.DBus", "NameOwnerChanged",
    				"/org/freedesktop/DBus", null, Gio.DBusSignalFlags.NO_MATCH_RULE, Lang.bind(this, this._onConnChange));
			}));
	},

	_hdlListNames: function(conn, query){
		let resp = conn.call_finish(query).get_child_value(0);

		for(let i = 0; i < resp.n_children(); i++){
			let path = resp.get_child_value(i).get_string()[0];
			if(path.search('^org.mpris.MediaPlayer2') == 0)
				this._addMPRISStream(path, null);
		}

		this._parent._addExistingStreams();
	},

	_addMPRISStream: function(path, uname){
		this._dbus.call('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "GetConnectionUnixProcessID",
			GLib.Variant.new('(s)', [path]), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, -1, null,
			Lang.bind(this, function(conn, query){
				let pid = conn.call_finish(query).get_child_value(0).get_uint32();
				if(!(pid in this._mprisStreams)){
					this._mprisStreams[pid] = '';

					let add = Lang.bind(this, function(uname){
						let nStr = new MPRISStream(uname, pid, this._dbus, this._paDBus);
						this._mprisStreams[pid] = nStr;
						this.actor.add(nStr.actor);
						this._mprisStreams.length ++;
					});

					if(uname == null){
						this._dbus.call('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "GetNameOwner",
							GLib.Variant.new('(s)', [path]), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, -1, null, 
							Lang.bind(this, function(conn, query){
								let resp = conn.call_finish(query);
								resp = resp.get_child_value(0).unpack();
								if(resp != null)
									add(resp);
							})
						);/*
						uname = this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "GetNameOwner",
							GLib.Variant.new('(s)', [path]), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, -1, null);
						uname = uname.get_child_value(0).unpack();*/
					}

					if(uname != null){
						add(uname);/*
						let nStr = new MPRISStream(uname, pid, this._dbus, this._paDBus);
						this._mprisStreams[pid] = nStr;
						this.actor.add(nStr.actor);
						this._mprisStreams.length ++;*/
					}
				}
			})
		);
	},

	removePAStream:function(path){
		for(let pid in this._mprisStreams){
			if(this._mprisStreams[pid]._paPath == path){
				this._mprisStreams[pid].unsetPAStream();
				break;
			}
		}
	},

	isMPRISStream: function(pid, path){
		if(pid in this._mprisStreams){
			this._mprisStreams[pid].setPAStream(path);
			return true;
		}
		return false;
	},

	_onConnChange: function(conn, sender, object, iface, signal, param, user_data){
		let path = param.get_child_value(0).get_string()[0];
		let add = (param.get_child_value(1).get_string()[0] == '');

		if(path.search('^org.mpris.MediaPlayer2') != 0)
			return;

		if(add){
			let uName = param.get_child_value(2).get_string()[0];
			this._addMPRISStream(path, uName);
		}
		else {
			for(let k in this._mprisStreams){
				let uName = param.get_child_value(1).get_string()[0];
				if(k != 'length' && this._mprisStreams[k]._path == uName){
					this._mprisStreams[k].destroy();
					delete this._mprisStreams[k];
					this.actor.queue_relayout();
					break;
				}
			}
		}
	},

	_onDestroy: function(){
		this._dbus.signal_unsubscribe(this._sigNOC);
		this._dbus.call('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "RemoveMatch",
			GLib.Variant.new('(s)', [WATCH_RULE]), null, Gio.DBusCallFlags.NONE, -1, null, null);
	}

});

const MPRISStream = new Lang.Class({
	Name: 'MPRISStream',
	Extends: StreamBase,

	_init: function(dbusPath, pid, dbus, paconn){
		this.parent(paconn);
		this._path = dbusPath;
		this._procID = pid;
		this._dbus = dbus;
		this._mediaLength = 0;
		this._sigFVol = this._sigFMute = -1;

		this.unsetPAStream();

		this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
			GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2', 'DesktopEntry']), GLib.VariantType.new("(v)"),
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, this._hdlDesktopEntry));

		this._songLbl = new St.Label({style_class:'mpris-meta-title'});
		this._artistLbl = new St.Label({style_class:'mpris-meta-info'});
		this._albumLbl = new St.Label({style_class:'mpris-meta-info'});
		this._albumArt = new St.Icon({style_class:'mpris-album-art'});

		this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
			GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2.Player', 'Metadata']), GLib.VariantType.new("(v)"),
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let response = conn.call_finish(query).get_child_value(0).unpack();
				this._updateMetadata(response);
			})
		);

		this._playBtn = new St.Button({child: new St.Icon({icon_name: 'media-playback-start-symbolic'}), style_class:'mpris-play-button'});
		this._prevBtn = new St.Button({child: new St.Icon({icon_name: 'media-skip-backward-symbolic'}), style_class:'mpris-previous-button'});
		this._nextBtn = new St.Button({child: new St.Icon({icon_name: 'media-skip-forward-symbolic'}), style_class:'mpris-next-button'});

		this._posSlider = new Slider.Slider(0);
		this._timeLapLbl = new St.Label({style_class:'mpris-time-label'});
		this._timeRemLbl = new St.Label({style_class:'mpris-time-label'});

		this._artistBox = new St.BoxLayout();
		this._artistBox.add(new St.Label({text:'by', style_class:'mpris-label-subtext'}));
		this._artistBox.add(this._artistLbl);
		this._albumBox = new St.BoxLayout();
		this._albumBox.add(new St.Label({text:'from', style_class:'mpris-label-subtext'}));
		this._albumBox.add(this._albumLbl);
		this._detailBox = new St.BoxLayout({vertical:true});
		this._detailBox.add(this._songLbl);
		this._detailBox.add(this._artistBox);
		this._detailBox.add(this._albumBox);
		this._sigUpdPos = 0;

		let mediaControls = new St.BoxLayout({style_class: 'mpris-player-controls'});
		mediaControls.add(this._prevBtn);
		mediaControls.add(this._playBtn);
		mediaControls.add(this._nextBtn);

		let innerBox = new St.BoxLayout({vertical:true});
		innerBox.add(this._detailBox);
		innerBox.add(mediaControls);

		this._metaDisplay = new St.BoxLayout({style_class:'mpris-metadata-display'});
		this._metaDisplay.add(this._albumArt);
		this._metaDisplay.add(innerBox);

		this._timeBox = new St.BoxLayout({style_class:'mpris-time-display'});
		this._timeBox.add(this._timeLapLbl);
		this._timeBox.add(this._posSlider.actor, {expand:true});
		this._timeBox.add(this._timeRemLbl);

		this.actor.add(this._metaDisplay);
		this.actor.add(this._timeBox, {expand:true});

		this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
			GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']), GLib.VariantType.new("(v)"),
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let response = conn.call_finish(query).get_child_value(0).unpack().get_string()[0];
				if(response == 'Playing')
					this._setStatePlaying();
				else if(response == 'Paused'){
					this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
						GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']), GLib.VariantType.new("(v)"),
						Gio.DBusCallFlags.NONE, -1, null, 
						Lang.bind(this, function(conn, query){
							let response = conn.call_finish(query).get_child_value(0).unpack();
							this._mediaPosition = response.get_int64();

							this._timeLapLbl.text = this._formatSeconds(Math.floor(this._mediaPosition/1000000));
							this._timeRemLbl.text = '-'+this._formatSeconds(Math.floor((this._mediaLength - this._mediaPosition)/1000000));
							this._posSlider.setValue(this._mediaPosition/this._mediaLength);
						})
					);
				}
				else if(response == 'Stopped'){
					this.setDisplayState(0);
				}
			})
		);

		//Signal handlers
		this._sigPropChange = this._dbus.signal_subscribe(this._path, 'org.freedesktop.DBus.Properties',
			'PropertiesChanged', '/org/mpris/MediaPlayer2', null, Gio.DBusSignalFlags.NONE, 
			Lang.bind(this, this._onPropChange), null);
		this._sigSeeked = this._dbus.signal_subscribe(this._path, 'org.mpris.MediaPlayer2.Player',
			'Seeked', '/org/mpris/MediaPlayer2', null, Gio.DBusSignalFlags.NONE, 
			Lang.bind(this, this._onPropChange), null);

		this._posSlider.connect('value-changed', Lang.bind(this, this._onPosSliderChange));

		this._playBtn.connect('clicked', Lang.bind(this, this._onControlBtnClick));
		this._nextBtn.connect('clicked', Lang.bind(this, this._onControlBtnClick));
		this._prevBtn.connect('clicked', Lang.bind(this, this._onControlBtnClick));

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

		this._label.connect('button-press-event', Lang.bind(this, this._raise));
	},

		//Async functions
	_hdlDesktopEntry: function(conn, result){
		let res = conn.call_finish(result);
		res = res.get_child_value(0).unpack();
		
		let dName = res.get_string()[0];
		let icon;
		let app = Shell.AppSystem.get_default().lookup_app(dName+".desktop");
		if(app != null){
			let info = app.get_app_info();
			this._label.text = info.get_name();
			icon = new St.Icon({style_class: 'simple-stream-icon'});
			icon.set_gicon(info.get_icon());
		} else {
			icon = new St.Icon({icon_name: 'package_multimedia', style_class: 'simple-stream-icon'});
			this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
				GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2', 'Identity']), GLib.VariantType.new("(v)"),
				Gio.DBusCallFlags.NONE, -1, null, 
				Lang.bind(this, function(conn, query){
					let res = conn.call_finish(query).get_child_value(0).get_string()[0];
					this.label.text = res;
				})
			);
		}

		this._muteBtn.child = icon;
	},

	setDisplayState: function(state){
		if(state == 0){
			this._prevBtn.hide();
			this._nextBtn.hide();
			this._timeBox.hide();
			this._detailBox.hide();
			this._albumArt.hide();

			this.actor.set_vertical(false);
			this._metaDisplay.add_style_pseudo_class('alone');
			this._playBtn.add_style_pseudo_class('alone');
			this._volCtrl.add_style_pseudo_class('alone');
		}
		else if(state == 1){
			this.actor.set_vertical(true);
			this._metaDisplay.remove_style_pseudo_class('alone');
			this._playBtn.remove_style_pseudo_class('alone');
			this._volCtrl.remove_style_pseudo_class('alone');

			this._prevBtn.show();
			this._nextBtn.show();
			this._timeBox.show();
			this._detailBox.show();
			this._albumArt.show();
		}
	},

	setPAStream: function(path){
		if(this._sigFVol != -1){
			this._volSlider.disconnect(this._sigFVol);
			this._muteBtn.disconnect(this._sigFMute);

			this._sigFMute = this._sigFVol = -1;
		}

		this.setPAPath(path);
	},

	unsetPAStream: function(){
		if(this._paPath){
			this._paDBus.signal_unsubscribe(this._sigVol);
			this._paDBus.signal_unsubscribe(this._sigMute);
		}

		this._paPath = null;

		this._sigFVol = this._volSlider.connect('value-changed', 
			Lang.bind(this, function(slider, value, property){
				this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Set",
					GLib.Variant.new('(ssv)', ['org.mpris.MediaPlayer2.Player', 'Volume', GLib.Variant.new_double(value)]), 
					null, Gio.DBusCallFlags.NONE, -1, null, null);
			})
		);
		this._sigFMute = this._muteBtn.connect('clicked', Lang.bind(this, function(){
				this._muteVal = !this._muteVal;
				this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Set",
					GLib.Variant.new('(ssv)', ['org.mpris.MediaPlayer2.Player', 'Volume', GLib.Variant.new_double(this._muteVal?0:this._appVol)]), 
					null, Gio.DBusCallFlags.NONE, -1, null, null);
			})
		);
	},


	_updateMetadata: function(meta){
		if(meta.n_children() == 0)
			this.setDisplayState(0);
		else {

			let metaD = {};
			for(let i = 0; i < meta.n_children(); i++){
				let [key, val] = meta.get_child_value(i).unpack();

				key = key.get_string()[0];
				val = val.unpack();
				metaD[key] = val;
			}

			if('xesam:title' in metaD){
				this._songLbl.text = metaD['xesam:title'].get_string()[0];
				this._songLbl.show();
			} else {
				this._songLbl.hide();
			}

			if('xesam:artist' in metaD){
				let artists = metaD['xesam:artist'];
				let str = artists.get_child_value(0).get_string()[0];

				for(let i = 1; i < artists.n_children(); i++)
					str += ', '+artists.get_child_value(i).get_string()[0];

				this._artistLbl.text = str;
				this._artistBox.show();
			} else {
				this._artistBox.hide();
			}

			if('xesam:album' in metaD){
				this._albumLbl.text = metaD['xesam:album'].get_string()[0];
				this._albumBox.show();
			} else {
				this._albumBox.hide();
			}

			if('mpris:artUrl' in metaD){
				let filePath = metaD['mpris:artUrl'].get_string()[0];
				let iconPath = filePath.substring(7, filePath.length);

				if(GLib.file_test(iconPath, GLib.FileTest.EXISTS)){
					let file = Gio.File.new_for_path(iconPath)
					let icon = new Gio.FileIcon({file:file});
					this._albumArt.gicon = icon;
				}
				this._albumArt.show();
			} else {
				this._albumArt.hide();
			}

			if('mpris:trackid' in metaD)
				this._mediaID = metaD['mpris:trackid'].get_string()[0];

			if('mpris:length' in metaD)
				this._mediaLength = metaD['mpris:length'].get_int64();
			else 
				this._mediaLength = 0;

			this.setDisplayState(1);
		}
	},

	_setStatePlaying: function(){
		this._playBtn.child.icon_name = 'media-playback-pause-symbolic';

		this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
			GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']), GLib.VariantType.new("(v)"),
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let response = conn.call_finish(query).get_child_value(0).unpack();
				this._mediaPosition = response.get_int64();

				if(this._sigUpdPos == 0)
					this._sigUpdPos = Loop.timeout_add_seconds(1, Lang.bind(this, this._updatePosition));
			})
		);
		this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
			GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2.Player', 'Rate']), GLib.VariantType.new("(v)"),
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let response = conn.call_finish(query).get_child_value(0).unpack();
				this._mediaRate = response.get_double();
			})
		);
	},

	_onPropChange: function(conn, sender, object, iface, signal, param, user_data){
		if(signal == 'PropertiesChanged'){
			let sIface = param.get_child_value(0).get_string()[0];

			if(sIface == 'org.mpris.MediaPlayer2.Player'){
				let sigs = param.get_child_value(1);
				for(let i = 0; i < sigs.n_children(); i++){
					let [key, val] = sigs.get_child_value(i).unpack();
					key = key.get_string()[0];
					val = val.unpack();

					if(key == 'Metadata')
						this._updateMetadata(val);
					else if(key == 'PlaybackStatus'){
						let state = val.get_string()[0];
						if(state == 'Playing'){
							this._setStatePlaying();
						}
						else {
							if (this._sigUpdPos != 0) {
								Loop.source_remove(this._sigUpdPos);
								this._sigUpdPos = 0;
							}
							this._playBtn.child.icon_name = 'media-playback-start-symbolic';        
						}
					}
					else if(key == 'Volume'){
						let vol = val.get_double();
						if(!this._muteVal) this._appVol = vol;
						if(this._paPath == null)
							this._volSlider.setValue(vol);
					}/*
					else if(key == 'CanGoNext'){
						let b = val.get_boolean();
						print('CGN:'+b);
						this._nextBtn.can_focus = b;
						this._nextBtn.reactive = b;
						if(b)
							this._nextBtn.remove_style_pseudo_class('disabled');
						else 
							this._nextBtn.add_style_pseudo_class('disabled');
					}/*
					else 
						log('Unhandled '+key);*/
				}


			}
		} else if(signal == 'Seeked'){
			//Have to manually get the time as banshee doesn't send it.
			this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
				GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']), GLib.VariantType.new("(v)"),
				Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
					let response = conn.call_finish(query).get_child_value(0).unpack();
					this._mediaPosition = response.get_int64();
				})
			);
		}
	},

	_onControlBtnClick: function(button){
		if(button == this._playBtn){
			this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.mpris.MediaPlayer2.Player", "PlayPause",
				null, null, Gio.DBusCallFlags.NONE, -1, null, null);
		}
		else if(button == this._prevBtn){
			this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.mpris.MediaPlayer2.Player", "Previous",
				null, null, Gio.DBusCallFlags.NONE, -1, null, null);
		}
		else if(button == this._nextBtn){
			this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.mpris.MediaPlayer2.Player", "Next",
				null, null, Gio.DBusCallFlags.NONE, -1, null, null);
		}
	},

	_onPosSliderChange: function(slider, value, property){
		if(this._mediaLength != 0){
			let position = Math.floor(value * this._mediaLength);
			this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.mpris.MediaPlayer2.Player", "SetPosition",
					GLib.Variant.new('(ox)', [this._mediaID, position]), null,
					Gio.DBusCallFlags.NONE, -1, null, null );
		}
	},

	_updatePosition: function(){
		if(this._mediaLength > 0 && this._mediaLength >= this._mediaPosition){
			this._sigUpdPos = Loop.timeout_add_seconds(1, Lang.bind(this, this._updatePosition));

			this._mediaPosition += 1000000*this._mediaRate;
			this._timeLapLbl.text = this._formatSeconds(Math.floor(this._mediaPosition/1000000));
			this._timeRemLbl.text = '-'+this._formatSeconds(Math.floor((this._mediaLength - this._mediaPosition)/1000000));
			this._posSlider.setValue(this._mediaPosition/this._mediaLength);
		}
	},

	_formatSeconds: function(seconds){
		let mod = seconds % 60
		let ans = mod.toString();
		if(mod < 10) ans = '0'+ans;
		seconds = Math.floor(seconds/60);
		if(seconds > 0){
			ans = (seconds % 60) + ':' + ans;
			seconds = Math.floor(seconds/60);
		} 
		else 
			ans = '0:'+ans;
		if(seconds > 0)
			ans = seconds +':'+ans;
		return ans;
	},

	_raise: function(){
		if(this._app == null){
			this._app = WindowTracker.get_app_from_pid(this._procID);

			if(this._app == null){//Check the tray
				let trayNotifications = Main.messageTray.getSources();
				for(let i = 0; i < trayNotifications.length; i++)
					if(trayNotifications[i].pid == this._procID)
						this._app = trayNotifications[i].app;
			}

			if(this._app == null){//try raising a window via dbus
				this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.freedesktop.DBus.Properties", "Get",
					GLib.Variant.new('(ss)', ['org.mpris.MediaPlayer2', 'CanRaise']), GLib.VariantType.new("(v)"),
					Gio.DBusCallFlags.NONE, -1, null, 
					Lang.bind(this, function(conn, query){
						let response = conn.call_finish(query).get_child_value(0).unpack();
						if(response.get_boolean()){
							this._dbus.call(this._path, '/org/mpris/MediaPlayer2', "org.mpris.MediaPlayer2", "Raise",
								null, null, Gio.DBusCallFlags.NONE, -1, null, null);
							this._app = WindowTracker.get_app_from_pid(this._procID);
						}
					})
				);
			}
			
		}
		if(this._app != null)
			this._app.activate();
	},

	_onDestroy: function(){
		this._dbus.signal_unsubscribe(this._sigPropChange);
		this._dbus.signal_unsubscribe(this._sigSeeked);
		if(this._paPath){
			this._paDBus.signal_unsubscribe(this._sigVol);
			this._paDBus.signal_unsubscribe(this._sigMute);
		}
		if(this._sigUpdPos != 0) {
			Loop.source_remove(this._sigUpdPos);
			this._sigUpdPos = 0;
		}
	}
});