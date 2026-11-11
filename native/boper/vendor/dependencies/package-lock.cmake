# To perform `git clone` only when necessary, we declare the package using CPMDeclarePackage here,
# and call CPMAddPackage only when it is actually needed.

CPMDeclarePackage(asio                                        NAME asio                                        GITHUB_REPOSITORY chriskohlhoff/asio                                  GIT_TAG asio-1-39-0                                 DOWNLOAD_ONLY true)
CPMDeclarePackage(cxxopts                                     NAME cxxopts                                     GITHUB_REPOSITORY jarro2783/cxxopts                                   GIT_TAG v3.3.1                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(debug_assert                                NAME debug_assert                                GITHUB_REPOSITORY foonathan/debug_assert                              GIT_TAG v1.3.4                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(eternal                                     NAME eternal                                     GITHUB_REPOSITORY mapbox/eternal                                      GIT_TAG v1.0.1                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(exprtk                                      NAME exprtk                                      GITHUB_REPOSITORY ArashPartow/exprtk                                  GIT_TAG 0.0.3                                       DOWNLOAD_ONLY true)
CPMDeclarePackage(glob                                        NAME glob                                        GITHUB_REPOSITORY p-ranav/glob                                        GIT_TAG 9500d81a9798318252c0695ce909d56b35171173    DOWNLOAD_ONLY true)
CPMDeclarePackage(gsl                                         NAME gsl                                         GITHUB_REPOSITORY microsoft/GSL                                       GIT_TAG v5.0.1                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(natural_sort                                NAME natural_sort                                GITHUB_REPOSITORY scopeInfinity/NaturalSort                           GIT_TAG 5c71f466f29d44c8d976dc1ba077eae9b6ce672a    DOWNLOAD_ONLY true)
CPMDeclarePackage(nlohmann_json                               NAME nlohmann_json                               GITHUB_REPOSITORY nlohmann/json                                       GIT_TAG v3.12.0                                     DOWNLOAD_ONLY true)
CPMDeclarePackage(nod                                         NAME nod                                         GITHUB_REPOSITORY fr00b0/nod                                          GIT_TAG v0.5.4                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_array                               NAME pqrs_cf_array                               GITHUB_REPOSITORY pqrs-org/cpp-cf-array                               GIT_TAG v2.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_boolean                             NAME pqrs_cf_boolean                             GITHUB_REPOSITORY pqrs-org/cpp-cf-boolean                             GIT_TAG v1.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_bundle                              NAME pqrs_cf_bundle                              GITHUB_REPOSITORY pqrs-org/cpp-cf-bundle                              GIT_TAG v2.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_cf_ptr                              NAME pqrs_cf_cf_ptr                              GITHUB_REPOSITORY pqrs-org/cpp-cf-cf_ptr                              GIT_TAG v2.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_dictionary                          NAME pqrs_cf_dictionary                          GITHUB_REPOSITORY pqrs-org/cpp-cf-dictionary                          GIT_TAG v1.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_json                                NAME pqrs_cf_json                                GITHUB_REPOSITORY pqrs-org/cpp-cf-json                                GIT_TAG v2.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_number                              NAME pqrs_cf_number                              GITHUB_REPOSITORY pqrs-org/cpp-cf-number                              GIT_TAG v2.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_run_loop_thread                     NAME pqrs_cf_run_loop_thread                     GITHUB_REPOSITORY pqrs-org/cpp-cf-run_loop_thread                     GIT_TAG v4.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_set                                 NAME pqrs_cf_set                                 GITHUB_REPOSITORY pqrs-org/cpp-cf-set                                 GIT_TAG v1.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_string                              NAME pqrs_cf_string                              GITHUB_REPOSITORY pqrs-org/cpp-cf-string                              GIT_TAG v2.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_cf_url                                 NAME pqrs_cf_url                                 GITHUB_REPOSITORY pqrs-org/cpp-cf-url                                 GIT_TAG v1.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_dispatcher                             NAME pqrs_dispatcher                             GITHUB_REPOSITORY pqrs-org/cpp-dispatcher                             GIT_TAG v2.23.0                                     DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_environment_variable                   NAME pqrs_environment_variable                   GITHUB_REPOSITORY pqrs-org/cpp-environment_variable                   GIT_TAG v2.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_filesystem                             NAME pqrs_filesystem                             GITHUB_REPOSITORY pqrs-org/cpp-filesystem                             GIT_TAG v4.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_gcd                                    NAME pqrs_gcd                                    GITHUB_REPOSITORY pqrs-org/cpp-gcd                                    GIT_TAG v1.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_gsl                                    NAME pqrs_gsl                                    GITHUB_REPOSITORY pqrs-org/cpp-gsl                                    GIT_TAG v1.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_hash                                   NAME pqrs_hash                                   GITHUB_REPOSITORY pqrs-org/cpp-hash                                   GIT_TAG v2.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_hid                                    NAME pqrs_hid                                    GITHUB_REPOSITORY pqrs-org/cpp-hid                                    GIT_TAG v3.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_json                                   NAME pqrs_json                                   GITHUB_REPOSITORY pqrs-org/cpp-json                                   GIT_TAG v1.8.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_local_datagram                         NAME pqrs_local_datagram                         GITHUB_REPOSITORY pqrs-org/cpp-local_datagram                         GIT_TAG v10.7.0                                     DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_accessibility                      NAME pqrs_osx_accessibility                      GITHUB_REPOSITORY pqrs-org/cpp-osx-accessibility                      GIT_TAG v4.6.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_autorelease_pool                   NAME pqrs_osx_autorelease_pool                   GITHUB_REPOSITORY pqrs-org/cpp-osx-autorelease_pool                   GIT_TAG v1.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_application                        NAME pqrs_osx_application                        GITHUB_REPOSITORY pqrs-org/cpp-osx-application                        GIT_TAG v2.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_cg_display                         NAME pqrs_osx_cg_display                         GITHUB_REPOSITORY pqrs-org/cpp-osx-cg_display                         GIT_TAG v1.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_cg_event                           NAME pqrs_osx_cg_event                           GITHUB_REPOSITORY pqrs-org/cpp-osx-cg_event                           GIT_TAG v2.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_cg_event_tap                       NAME pqrs_osx_cg_event_tap                       GITHUB_REPOSITORY pqrs-org/cpp-osx-cg_event_tap                       GIT_TAG v2.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_chrono                             NAME pqrs_osx_chrono                             GITHUB_REPOSITORY pqrs-org/cpp-osx-chrono                             GIT_TAG v2.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_codesign                           NAME pqrs_osx_codesign                           GITHUB_REPOSITORY pqrs-org/cpp-osx-codesign                           GIT_TAG v3.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_file_monitor                       NAME pqrs_osx_file_monitor                       GITHUB_REPOSITORY pqrs-org/cpp-osx-file_monitor                       GIT_TAG v3.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_frontmost_application_monitor      NAME pqrs_osx_frontmost_application_monitor      GITHUB_REPOSITORY pqrs-org/cpp-osx-frontmost_application_monitor      GIT_TAG v6.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_hitoolbox                          NAME pqrs_osx_hitoolbox                          GITHUB_REPOSITORY pqrs-org/cpp-osx-hitoolbox                          GIT_TAG v1.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_input_source                       NAME pqrs_osx_input_source                       GITHUB_REPOSITORY pqrs-org/cpp-osx-input_source                       GIT_TAG v3.6.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_input_source_monitor               NAME pqrs_osx_input_source_monitor               GITHUB_REPOSITORY pqrs-org/cpp-osx-input_source_monitor               GIT_TAG v1.6.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_input_source_selector              NAME pqrs_osx_input_source_selector              GITHUB_REPOSITORY pqrs-org/cpp-osx-input_source_selector              GIT_TAG v4.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_device                   NAME pqrs_osx_iokit_hid_device                   GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_device                   GIT_TAG v5.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_device_open_checker      NAME pqrs_osx_iokit_hid_device_open_checker      GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_device_open_checker      GIT_TAG v2.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_device_report_monitor    NAME pqrs_osx_iokit_hid_device_report_monitor    GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_device_report_monitor    GIT_TAG v1.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_element                  NAME pqrs_osx_iokit_hid_element                  GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_element                  GIT_TAG v1.5.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_event_system_client      NAME pqrs_osx_iokit_hid_event_system_client      GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_event_system_client      GIT_TAG v1.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_manager                  NAME pqrs_osx_iokit_hid_manager                  GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_manager                  GIT_TAG v6.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_device_events_monitor    NAME pqrs_osx_iokit_hid_device_events_monitor    GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_device_events_monitor    GIT_TAG v5.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_system                   NAME pqrs_osx_iokit_hid_system                   GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_system                   GIT_TAG v2.1.6                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_hid_value                    NAME pqrs_osx_iokit_hid_value                    GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_hid_value                    GIT_TAG v4.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_iterator                     NAME pqrs_osx_iokit_iterator                     GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_iterator                     GIT_TAG v1.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_object_ptr                   NAME pqrs_osx_iokit_object_ptr                   GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_object_ptr                   GIT_TAG v3.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_power_management             NAME pqrs_osx_iokit_power_management             GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_power_management             GIT_TAG v2.5.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_registry_entry               NAME pqrs_osx_iokit_registry_entry               GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_registry_entry               GIT_TAG v3.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_return                       NAME pqrs_osx_iokit_return                       GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_return                       GIT_TAG v1.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_service_monitor              NAME pqrs_osx_iokit_service_monitor              GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_service_monitor              GIT_TAG v6.5.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_iokit_types                        NAME pqrs_osx_iokit_types                        GITHUB_REPOSITORY pqrs-org/cpp-osx-iokit_types                        GIT_TAG v6.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_json_file_monitor                  NAME pqrs_osx_json_file_monitor                  GITHUB_REPOSITORY pqrs-org/cpp-osx-json_file_monitor                  GIT_TAG v2.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_kern_return                        NAME pqrs_osx_kern_return                        GITHUB_REPOSITORY pqrs-org/cpp-osx-kern_return                        GIT_TAG v1.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_launch_services                    NAME pqrs_osx_launch_services                    GITHUB_REPOSITORY pqrs-org/cpp-osx-launch_services                    GIT_TAG v1.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_launchctl                          NAME pqrs_osx_launchctl                          GITHUB_REPOSITORY pqrs-org/cpp-osx-launchctl                          GIT_TAG v5.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_machine                            NAME pqrs_osx_machine                            GITHUB_REPOSITORY pqrs-org/cpp-osx-machine                            GIT_TAG v1.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_os_kext_return                     NAME pqrs_osx_os_kext_return                     GITHUB_REPOSITORY pqrs-org/cpp-osx-os_kext_return                     GIT_TAG v2.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_process_codesign_monitor           NAME pqrs_osx_process_codesign_monitor           GITHUB_REPOSITORY pqrs-org/cpp-osx-process_codesign_monitor           GIT_TAG v1.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_process_info                       NAME pqrs_osx_process_info                       GITHUB_REPOSITORY pqrs-org/cpp-osx-process_info                       GIT_TAG v2.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_session                            NAME pqrs_osx_session                            GITHUB_REPOSITORY pqrs-org/cpp-osx-session                            GIT_TAG v3.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_system_preferences                 NAME pqrs_osx_system_preferences                 GITHUB_REPOSITORY pqrs-org/cpp-osx-system_preferences                 GIT_TAG v6.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_system_preferences_monitor         NAME pqrs_osx_system_preferences_monitor         GITHUB_REPOSITORY pqrs-org/cpp-osx-system_preferences_monitor         GIT_TAG v1.5.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_workspace                          NAME pqrs_osx_workspace                          GITHUB_REPOSITORY pqrs-org/cpp-osx-workspace                          GIT_TAG v3.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_osx_xpc                                NAME pqrs_osx_xpc                                GITHUB_REPOSITORY pqrs-org/cpp-osx-xpc                                GIT_TAG v4.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_process                                NAME pqrs_process                                GITHUB_REPOSITORY pqrs-org/cpp-process                                GIT_TAG v2.6.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_regex                                  NAME pqrs_regex                                  GITHUB_REPOSITORY pqrs-org/cpp-regex                                  GIT_TAG v1.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_sign                                   NAME pqrs_sign                                   GITHUB_REPOSITORY pqrs-org/cpp-sign                                   GIT_TAG v1.1.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_spdlog                                 NAME pqrs_spdlog                                 GITHUB_REPOSITORY pqrs-org/cpp-spdlog                                 GIT_TAG v3.4.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_string                                 NAME pqrs_string                                 GITHUB_REPOSITORY pqrs-org/cpp-string                                 GIT_TAG v2.3.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_thread_wait                            NAME pqrs_thread_wait                            GITHUB_REPOSITORY pqrs-org/cpp-thread_wait                            GIT_TAG v2.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_unix_domain_stream                     NAME pqrs_unix_domain_stream                     GITHUB_REPOSITORY pqrs-org/cpp-unix_domain_stream                     GIT_TAG v5.2.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(pqrs_weakify                                NAME pqrs_weakify                                GITHUB_REPOSITORY pqrs-org/objc-weakify                               GIT_TAG v1.0.0                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(spdlog                                      NAME spdlog                                      GITHUB_REPOSITORY gabime/spdlog                                       GIT_TAG v1.17.0                                     DOWNLOAD_ONLY true)
CPMDeclarePackage(type_safe                                   NAME type_safe                                   GITHUB_REPOSITORY foonathan/type_safe                                 GIT_TAG v0.2.4                                      DOWNLOAD_ONLY true)
CPMDeclarePackage(ut                                          NAME ut                                          GITHUB_REPOSITORY boost-ext/ut                                        GIT_TAG v2.3.1                                      DOWNLOAD_ONLY true)

#
# Extra Package Info
#

set(_FILES_asio
  "asio/include/asio.hpp -> include/asio.hpp"
  "asio/include/asio     -> include/asio"
)
set(_FILES_cxxopts "include/cxxopts.hpp -> include/cxxopts.hpp")
set(_FILES_debug_assert "debug_assert.hpp -> include/debug_assert.hpp")
set(_FILES_exprtk "exprtk.hpp -> include/exprtk/exprtk.hpp")
set(_FILES_glob "single_include/glob/glob.hpp -> include/glob/glob.hpp")
set(_FILES_gsl "include/gsl -> include/gsl")
set(_FILES_natural_sort "natural_sort.hpp -> include/natural_sort.hpp")
set(_FILES_pqrs_osx_accessibility
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_osx_autorelease_pool
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_osx_application
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_osx_cg_event
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_osx_frontmost_application_monitor
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_osx_process_info
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_osx_workspace
  "include -> /"
  "src -> /"
)
set(_FILES_pqrs_spdlog
  "include/pqrs -> /include"
  "src/spdlog-build -> /src/spdlog-build"
)
set(_FILES_spdlog
  "include -> /"
  "src -> /src/spdlog"
)
