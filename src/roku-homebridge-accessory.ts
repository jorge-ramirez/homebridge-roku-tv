import {
  PlatformAccessory,
  Characteristic,
  Logger,
  Service,
  CharacteristicValue,
} from "homebridge";
import RokuClient, { Keys } from "roku-client";
import { HOME } from "roku-client/dist/keys";

import {
  RokuClientInfo,
  RokuHomebridgePlatform,
} from "./roku-homebridge-platform";
import { homeScreenActiveId } from "./settings";
import { MappedApp, RokuAppMap } from "./roku-app-map";
import { KeyCommand } from "roku-client/dist/keyCommand";

const pollingDefault = 30000;

/**
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class RokuHomebridgeAccessory {
  private informationService: Service;
  private readonly televisionService: Service;
  private readonly speakerService: Service;

  private readonly Characteristic: typeof Characteristic;
  private readonly logger: Logger;
  private applicationMap: RokuAppMap;

  private rokuClient(): RokuClient {
    return this.clientInfo.client;
  }

  // Constructor

  constructor(
    private readonly platform: RokuHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly clientInfo: RokuClientInfo,
    private readonly excludedApps: string[],
  ) {
    this.Characteristic = platform.Characteristic;
    this.logger = platform.log;
    this.applicationMap = new RokuAppMap(clientInfo.apps);
    this.informationService = this.createInformationService();
    this.televisionService = this.createTelevisionService();
    this.speakerService = this.createSpeakerService();

    this.logger.info("Roku TV IP is: ${clientInfo.client.ip}");

    this.configureServices();
    this.startPolling();
  }

  // Private Methods

  private createInformationService(): Service {
    return (
      this.accessory.getService(this.platform.Service.AccessoryInformation) ||
      this.accessory.addService(this.platform.Service.AccessoryInformation)
    );
  }

  private createSpeakerService(): Service {
    return (
      this.accessory.getService(this.platform.Service.TelevisionSpeaker) ||
      this.accessory.addService(this.platform.Service.TelevisionSpeaker)
    );
  }

  private createTelevisionService(): Service {
    return (
      this.accessory.getService(this.platform.Service.Television) ||
      this.accessory.addService(this.platform.Service.Television)
    );
  }

  private configureServices() {
    this.configureInformationService();
    this.configureSpeakerService();
    this.configureTelevisionService();
  }

  private configureInformationService() {
    this.informationService
      .setCharacteristic(
        this.Characteristic.Manufacturer,
        this.clientInfo.info.vendorName,
      )
      .setCharacteristic(
        this.Characteristic.Model,
        this.clientInfo.info.modelName,
      )
      .setCharacteristic(
        this.Characteristic.Name,
        this.clientInfo.info.userDeviceName,
      )
      .setCharacteristic(
        this.Characteristic.SerialNumber,
        this.clientInfo.info.serialNumber,
      );
  }

  private configureSpeakerService() {
    this.speakerService
      .setCharacteristic(
        this.Characteristic.Active,
        this.Characteristic.Active.ACTIVE,
      )
      .setCharacteristic(
        this.Characteristic.VolumeControlType,
        this.Characteristic.VolumeControlType.RELATIVE,
      );

    this.speakerService
      .getCharacteristic(this.Characteristic.VolumeSelector)
      .on("set", (selector, callback) => {
        if (selector === this.Characteristic.VolumeSelector.INCREMENT) {
          this.logger.info("Incrementing the Volume");
          this.clientInfo.client.command().volumeUp().send();
        } else {
          this.logger.info("Decrementing the volume");
          this.clientInfo.client.command().volumeDown().send();
        }

        callback(null);
      });

    this.speakerService
      .getCharacteristic(this.Characteristic.Mute)
      .on("set", (value, callback) => {
        this.logger.info("Toggling Mute");
        this.clientInfo.client.command().volumeMute().send();

        callback(null);
      });
  }

  private configureTelevisionService() {
    this.televisionService.displayName = "Roku TV Service";

    this.televisionService.setCharacteristic(
      this.Characteristic.SleepDiscoveryMode,
      this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );
    this.televisionService.setCharacteristic(
      this.Characteristic.ConfiguredName,
      this.clientInfo.info.userDeviceName,
    );

    this.configureTelevisionServiceActive();
    this.configureTelevisionApplicationInputs();
    this.configureTelevisionServiceRemoteKey();

    this.updatePowerAndActiveApplication();
    this.configureTelevisionActiveApplication();
  }

  private configureTelevisionApplicationInputs() {
    const apps = this.applicationMap
      .getApps()
      .filter((x) => !this.excludedApps.includes(x.name));

    apps.forEach((app) => {
      this.logger.info(
        `Adding Input ${app.name} with info ID: ${app.id}, TYPE: ${app.type}`,
      );

      const inputType =
        app.type === "Home"
          ? this.Characteristic.InputSourceType.HOME_SCREEN
          : this.Characteristic.InputSourceType.HDMI;

      const inputService =
        this.accessory.getService(app.name) ||
        this.accessory.addService(
          this.platform.Service.InputSource,
          app.name,
          app.id.toString(),
        );

      inputService
        .setCharacteristic(this.Characteristic.Identifier, app.id)
        .setCharacteristic(this.Characteristic.ConfiguredName, app.name)
        .setCharacteristic(
          this.Characteristic.IsConfigured,
          this.Characteristic.IsConfigured.CONFIGURED,
        )
        .setCharacteristic(this.Characteristic.InputSourceType, inputType);

      this.televisionService.addLinkedService(inputService);
    });
  }

  private configureTelevisionServiceActive() {
    this.televisionService
      .getCharacteristic(this.Characteristic.Active)
      .on("get", async (callback) => {
        const activeState = await this.fetchTelevisionActiveState();
        callback(null, activeState);
      })
      .on("set", async (onOrOff, callback) => {
        this.logger.info("set Active => setNewValue: " + onOrOff);
        await this.clientInfo.client
          .command()
          .keypress({
            command: onOrOff ? "poweron" : "poweroff",
            name: "power",
          })
          .send();

        await this.updatePowerAndActiveApplication();

        callback(null);
      });
  }

  private configureTelevisionActiveApplication() {
    this.televisionService
      .getCharacteristic(this.Characteristic.ActiveIdentifier)
      .on("get", async (callback) => {
        const rokuApp = await this.clientInfo.client.active();

        if (rokuApp == null) {
          callback(null, homeScreenActiveId);
          return;
        }

        const app = this.applicationMap.getAppFromRokuId(rokuApp.id);
        this.logger.info(`Get Active Input Source: ${app.name}`);

        if (app) {
          callback(null, app.id);
        } else {
          callback(null, homeScreenActiveId);
        }
      })
      .on("set", async (identifier, callback) => {
        // the value will be the value you set for the Identifier Characteristic
        // on the Input Source service that was selected - see input sources below.

        const app: MappedApp = this.applicationMap.getAppFromId(
          identifier as number,
        );

        this.logger.info(`set Active Input Source => ${app.name}`);

        if (app.rokuAppId === homeScreenActiveId) {
          await this.clientInfo.client.command().keypress(HOME).send();
        } else {
          try {
            await this.clientInfo.client.launch(app.rokuAppId);
          } catch (e) {
            this.logger.error("Failed to launch app", e);
            this.updatePowerAndActiveApplication();
          }
        }

        callback(null);
      });
  }

  private configureTelevisionServiceRemoteKey() {
    this.televisionService
      .getCharacteristic(this.Characteristic.RemoteKey)
      .on("set", (newValue, callback) => {
        const keyAndName = this.remoteKeyToKeyCommandAndName(newValue);

        if (keyAndName) {
          this.logger.info("set Remote Key Pressed: " + keyAndName.name);
          this.clientInfo.client
            .command()
            .keypress(keyAndName.keyCommand)
            .send();
        } else {
          this.logger.info(
            "unknown Remote Key Pressed: " + newValue.toString(),
          );
        }

        callback(null);
      });
  }

  private async fetchTelevisionActiveState() {
    const isOn = await this.isTelevisionOn();

    return isOn
      ? this.Characteristic.Active.ACTIVE
      : this.Characteristic.Active.INACTIVE;
  }

  private async isTelevisionOn(): Promise<boolean> {
    const info = await this.clientInfo.client.info();
    const isOn = info["powerMode"] === "PowerOn";

    this.logger.info("Fetched Power State: " + isOn);

    return isOn;
  }

  private remoteKeyToKeyCommandAndName(
    remoteKey: CharacteristicValue,
  ): { keyCommand: KeyCommand; name: string } | undefined {
    switch (remoteKey) {
      case this.Characteristic.RemoteKey.REWIND:
        return { keyCommand: Keys.REVERSE, name: "REVERSE" };
      case this.Characteristic.RemoteKey.FAST_FORWARD:
        return { keyCommand: Keys.FORWARD, name: "FORWARD" };
      case this.Characteristic.RemoteKey.NEXT_TRACK:
        return { keyCommand: Keys.RIGHT, name: "RIGHT" };
      case this.Characteristic.RemoteKey.PREVIOUS_TRACK:
        return { keyCommand: Keys.LEFT, name: "LEFT" };
      case this.Characteristic.RemoteKey.ARROW_UP:
        return { keyCommand: Keys.UP, name: "UP" };
      case this.Characteristic.RemoteKey.ARROW_DOWN:
        return { keyCommand: Keys.DOWN, name: "DOWN" };
      case this.Characteristic.RemoteKey.ARROW_LEFT:
        return { keyCommand: Keys.LEFT, name: "LEFT" };
      case this.Characteristic.RemoteKey.ARROW_RIGHT:
        return { keyCommand: Keys.RIGHT, name: "RIGHT" };
      case this.Characteristic.RemoteKey.SELECT:
        return { keyCommand: Keys.SELECT, name: "SELECT" };
      case this.Characteristic.RemoteKey.BACK:
        return { keyCommand: Keys.BACK, name: "BACK" };
      case this.Characteristic.RemoteKey.EXIT:
        return { keyCommand: Keys.HOME, name: "HOME" };
      case this.Characteristic.RemoteKey.PLAY_PAUSE:
        return { keyCommand: Keys.PLAY, name: "PLAY" };
      case this.Characteristic.RemoteKey.INFORMATION:
        return { keyCommand: Keys.INFO, name: "INFO" };
    }

    return undefined;
  }

  private startPolling() {
    const pollingInterval =
      this.platform.config.pollingInterval ?? pollingDefault;

    setInterval(() => {
      this.updatePowerAndActiveApplication();
    }, pollingInterval);
  }

  async updatePowerAndActiveApplication() {
    this.clientInfo.client.info().then((info) => {
      const isOn = info["powerMode"] === "PowerOn";

      this.logger.debug(`Power State is: ${info["powerMode"]} ${isOn}`);
      const isAlreadyON =
        this.televisionService.getCharacteristic(this.Characteristic.Active)
          .value === this.Characteristic.Active.ACTIVE;

      if (isOn == isAlreadyON) {
        return;
      }

      this.televisionService.updateCharacteristic(
        this.Characteristic.Active,
        isOn
          ? this.Characteristic.Active.ACTIVE
          : this.Characteristic.Active.INACTIVE,
      );
    });

    this.clientInfo.client.active().then((app) => {
      const rokuId = app ? app.id : homeScreenActiveId;
      const mappedApp = this.applicationMap.getAppFromRokuId(rokuId);

      this.logger.debug(
        `Active App is: ${mappedApp.name} ${mappedApp.id} ${mappedApp.rokuAppId}`,
      );

      this.televisionService
        .getCharacteristic(this.Characteristic.ActiveIdentifier)
        .updateValue(mappedApp.id);

      this.televisionService.updateCharacteristic(
        this.Characteristic.ActiveIdentifier,
        mappedApp.id,
      );
    });
  }
}
