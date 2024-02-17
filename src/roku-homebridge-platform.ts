import {
  API,
  Categories,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service,
} from "homebridge";
import { RokuClient, RokuApp, RokuDeviceInfo } from "roku-client";

import { homeScreenActiveId, PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { RokuHomebridgeAccessory } from "./roku-homebridge-accessory";

interface RokuHomebridgePlatformConfig {
  name?: string;
  excludedApps?: string[];
  pollingInterval?: number;
}

export class RokuHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: RokuHomebridgePlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug("Finished initializing platform:", this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on("didFinishLaunching", async () => {
      log.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
      this.discoverDevices()
        .then()
        .catch((e) => this.log.debug(e));
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info("Loading accessory from cache:", accessory.displayName);
    this.accessories.push(accessory);
  }

  private async createClientInfoFromClient(
    rokuClient: RokuClient,
  ): Promise<RokuClientInfo> {
    const info = await rokuClient.info();
    const apps = await rokuClient.apps();

    // add an application representing the Home screen
    apps.push({
      name: "Home",
      type: "Home",
      id: homeScreenActiveId,
      version: "1",
    });

    return {
      client: rokuClient,
      apps,
      info,
    };
  }

  /**
   * This method registers discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  private async discoverDevices() {
    // discover all of the Roku clients on the network
    const rokuClients = await RokuClient.discoverAll();

    // for each client, discover its system information and installed applications
    const rokuClientInfos: RokuClientInfo[] = await Promise.all(
      rokuClients.map(
        async (rokuClient) => await this.createClientInfoFromClient(rokuClient),
      ),
    );

    rokuClientInfos.forEach((rokuClientInfo) => {
      this.createAccessoryFromRokuClientInfo(rokuClientInfo);
    });
  }

  private createAccessoryFromRokuClientInfo(clientInfo: RokuClientInfo) {
    // generate a unique id for the accessory this should be generated from
    // something globally unique, but constant, for example, the device serial
    // number or MAC address
    const homebridgeAccessoryId = this.api.hap.uuid.generate(
      clientInfo.info.deviceId,
    );

    // see if an accessory with the same uuid has already been registered and restored from
    // the cached devices we stored in the `configureAccessory` method above
    const existingAccessory = this.accessories.find(
      (accessory) => accessory.UUID === homebridgeAccessoryId,
    );

    if (existingAccessory) {
      // the accessory already exists
      this.restoreExistingAccessoryFromClientInfo(
        existingAccessory,
        clientInfo,
      );
    } else {
      // the accessory does not yet exist, so we need to create it
      this.createNewAccessoryFromClientInfo(homebridgeAccessoryId, clientInfo);
    }
  }

  private restoreExistingAccessoryFromClientInfo(
    existingAccessory,
    deviceInfo: RokuClientInfo,
  ) {
    this.log.info(
      "Restoring existing accessory from cache:",
      existingAccessory.displayName,
    );

    // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
    // existingAccessory.context.device = device;
    // this.api.updatePlatformAccessories([existingAccessory]);
    // create the accessory handler for the restored accessory
    // this is imported from `platformAccessory.ts`
    new RokuHomebridgeAccessory(
      this,
      existingAccessory,
      deviceInfo,
      this.config.excludedApps ?? [],
    );
  }

  private createNewAccessoryFromClientInfo(
    uuid: string,
    deviceInfo: RokuClientInfo,
  ) {
    this.log.info("Adding new accessory:", deviceInfo.info.userDeviceName);

    const accessory = new this.api.platformAccessory(
      deviceInfo.info.userDeviceName,
      uuid,
      Categories.TELEVISION,
    );

    new RokuHomebridgeAccessory(
      this,
      accessory,
      deviceInfo,
      this.config.excludedApps ?? [],
    );

    // link the accessory to your platform
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }
}

export interface RokuClientInfo {
  client: RokuClient;
  apps: RokuApp[];
  info: RokuDeviceInfo;
}
